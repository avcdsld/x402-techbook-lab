# x402 決済プロトコルの実装と批判的検証

技術書典21の記事「x402 決済プロトコルの実装と批判的検証」の実験コード。

- 実施日：2026-10-15（UTC）
- 全実験の再実行：`cd lab && npm run all`（anvil を 8545 で起動しておくこと）
- ログ：`results/exp0.log` 〜 `results/exp3.log`

## バージョン

| 要素 | 版 | 備考 |
| --- | --- | --- |
| x402 仕様・SDKソース | `x402-foundation/x402` @ `faa1c694`（2026-10-15） | `vendor/x402`（参照用） |
| `@x402/core` `evm` `express` `fetch` `extensions` | 2.28.0（npm） | SDK は未改変。フックだけ差し込み |
| viem | 2.57.7 | |
| USDC 実装 | `circlefin/stablecoin-evm` @ `fc85788`（2026-08-12）の FiatTokenV2_2 | `vendor/stablecoin-evm`。ソースをそのままコンパイル |
| ローカルEVM | anvil（Foundry 1.7.1, chainId 31337） | |
| solc | 0.6.12（USDC）／0.8.30（自作ウォレット） | |
| Node.js | 22.22.0 | |

### 実環境との違い

- USDC はプロキシなしで直接デプロイ。ロジック（EIP-3009、EIP-1271 対応）は本物と同じソース。
- ファシリテーターは HTTP 分離せず、リソースサーバーと同一プロセス（ログと故障注入を挟むため）。
- anvil に Multicall3 がないため、SDK の失敗原因の診断が効かない場面がある。
- 自作ウォレットは owner が直接署名する素朴な形式。実在のスマートウォレットとは違う。
- 「応答の喪失」は settle 成功後に TCP ソケットを破棄して再現。

## ファイル構成

- `contracts/src/RevocableWallet.sol` — EIP-1271。owner を替えると過去の署名が全部無効になる
- `contracts/src/AgentWallet.sol` — EIP-1271。エージェント用セッション鍵。対照用 CountingWallet も含む
- `lab/src/chain.ts` — anvil・USDC・ウォレットのデプロイ
- `lab/src/stack.ts` — 公式SDKで組んだファシリテーター / サーバー / クライアント＋故障注入
- `lab/src/exp0〜3-*.ts` — 各実験

---

## 実験0：正常系

`GET /report` → 402 → EIP-712 署名 → verify → handler 実行 → settle（`transferWithAuthorization`）→ 200。買い手 −0.01 USDC、売り手 +0.01 USDC。ETH 残高 0 のコントラクトウォレットからも支払えた。

SDK の処理順は verify → ハンドラー実行 → settle → 応答送信。settle 失敗時はレスポンスを捨てて 402 を返す。

## 実験1：署名は正しいのに、支払えない

| ケース | HTTP | 送金 | ファシリテーターの tx | ファシリテーターのガス |
| --- | --- | --- | --- | --- |
| A 1271・対照 | 200 | 0.01 | 1 | 約10万gas分 |
| B 1271・verify 後に owner 交代 | 402 | 0 | 0 | 0 |
| C EOA・verify 後に `cancelAuthorization` | 402 | 0 | 0 | 0 |
| D 1271・settle tx 送信後に owner 交代 | 402 | 0 | 1（revert） | 約5.2万gas分 |
| E EOA・settle tx 送信後に `cancelAuthorization` | 402 | 0 | 1（revert） | 約3.4万gas分 |

B・C は settle 前の再検証で止まり tx は出ない。D・E は検証と送信の間をすり抜け、tx が revert しファシリテーターがガス代を負担した。EIP-1271 固有ではなく、EOA でも `cancelAuthorization` や残高移動で同じことが起きる。全ケースでハンドラーは実行済み。得をした者はいない。

## 実験2：同じものに二度払う

A〜F：応答を1回破棄して再試行。G〜I：破棄なし、同時送信。

| | 重複防止 | 再試行のしかた | 最終 | 支払い回数 | 提供 |
| --- | --- | --- | --- | --- | --- |
| A | なし | SDK で再リクエスト（新しい署名） | 200 | 2 | 2 |
| B | なし | 同じ署名を再送 | 402 | 1 | 1 |
| C | 公式 `payment-identifier` | 同じ署名を再送 | 200 | 1 | 1 |
| D | 公式 `payment-identifier` | 同じ id で新しい署名 | 409 | 1 | 1 |
| D2 | 同上 | D の後、断られた署名を売り手が実行 | 成功 | 2 | 1 |
| E | 公式 `payment-identifier` | 再起動：id も署名も新規 | 200 | 2 | 2 |
| F | アプリの購入 ID | 再起動：同じ購入 ID で再リクエスト | 200 | 1 | 1 |
| G | 同上（予約なし） | 同時送信 | 200/200 | 2 | 2 |
| H | 同上、ファシリテーターが素の viem | 同時送信 | 402/200 | 1 | 2 |
| I | 購入 ID ＋処理中の予約 | 同時送信 | 409/200 | 1 | 1 |

nonce は同じ署名の再利用だけを防ぐ。SDK の再試行は新しい署名を作るので別の送金になる（A）。`payment-identifier` は宣言と抽出の関数だけで、重複判定のストアは実装者の責任。409 で断られた署名も有効期限まで実行可能（D2）。購入の同一性はアプリ層で扱う必要がある（F〜I）。

## 実験3：AI の財布と支出ポリシー

3つの層で同じシナリオを流した。

- L0 SDK 既定：`spendControls`（1回あたり上限・トークン許可リスト）
- L1 クライアント方針：L0 ＋ 支払先許可リスト・タスク予算・再購入禁止・署名有効期間上限
- L2 オンチェーン：クライアント側は制御なし。`AgentWallet` のセッション鍵だけ

| シナリオ | L0 SDK 既定 | L1 クライアント方針 | L2 オンチェーン |
| --- | --- | --- | --- |
| 1 正規の API・0.01 | 0.01 [200] | 0.01 [200] | 0.01 [200] |
| 2 知らない支払先 | 0.01 [200] | 0 [拒否] | 0 [402] |
| 3 正規の支払先が 0.9 を要求 | 0.90 [200] | 0.90 [200] | 0 [402] |
| 4 同じレポートを3回 | 0.03 | 0.01 [200,拒否,拒否] | 0.03 |
| 5 0.3 を別々に6回 | 1.80 | 0.90 [3回で予算切れ] | 0.90 [残高切れ] |
| 6 署名の有効期間 1 年を要求 | 0.01 [200] | 0 [拒否] | 0 [402] |

SDK 既定は1回の額とトークン種類だけを見る。支払先・累積額・有効期間は見ない。`isValidSignature` は `staticcall` で呼ばれるため累積支出をカウントできない。オンチェーンでの予算制限は実質的にウォレットの残高になる。L1 はプロセス内のコードなので迂回可能、L2 はセッション鍵が漏れても制約の範囲内に収まる。

---

## やっていないこと

- LLM を接続したエージェント（プロンプトインジェクション、支払先のすり替え）。
- EIP-7702、Permit2 経路、ERC-7710 経路。
- テストネット／実ネットワーク。
- ファシリテーターを HTTP で分離した構成。
- `simulateInSettle: true` の挙動。
- `receiveWithAuthorization` との比較。
- upfront フロー。
- `authorizationState` による支払いの確認。
- Sign-In-With-X 拡張。
- batch-settlement など exact 以外の方式。

## 実行手順

```sh
git clone https://github.com/x402-foundation/x402.git vendor/x402 && git -C vendor/x402 checkout faa1c694c66a3732aaabbce93bdae140e521a67d
git clone https://github.com/circlefin/stablecoin-evm.git vendor/stablecoin-evm && git -C vendor/stablecoin-evm checkout fc85788bc7c23cefe3df1a757133048bfddadeaa
git clone --depth 1 -b v1.11.0 https://github.com/foundry-rs/forge-std.git contracts/lib/forge-std
(cd contracts && npm ci && forge build)
(cd lab && npm ci)
anvil --port 8545 &   # 別端末でも可
(cd lab && npm run all)
```
