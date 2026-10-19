# x402 ローカル実験ノート

技術書典寄稿「支払えることと、決済できること」のための実験。**記事原稿ではなく、観察の記録。**

- 実施日：2026-10-15（UTC）
- 全実験の再実行：`cd lab && npm run all`（anvil を 8545 で起動しておく。所要 約40秒）
- ログ：`results/exp0.log` 〜 `results/exp3.log`

## 何を使ったか（版の固定）

| 要素 | 版 | 備考 |
| --- | --- | --- |
| x402 仕様・SDKソース | `x402-foundation/x402` @ `faa1c694`（2026-10-15） | `vendor/x402` |
| `@x402/core` `evm` `express` `fetch` `extensions` | **2.28.0**（npm、完全固定） | SDKのコードには手を入れていない。差し込んだのはフックだけ |
| viem | 2.57.7 | |
| USDC 実装 | `circlefin/stablecoin-evm` @ `fc85788`（2026-08-12）の **FiatTokenV2_2** | `vendor/stablecoin-evm`。ソースをそのままコンパイル |
| ローカルEVM | anvil（Foundry 1.7.1, chainId 31337） | |
| solc | 0.6.12（USDC）／0.8.30（自作ウォレット） | |
| Node.js | 22.22.0 | |

### 本物と違うところ

- USDC はプロキシを介さず実装コントラクトを直接デプロイし `initialize*` を呼んだ。ロジック（EIP-3009、`SignatureChecker`による EIP-1271 対応）は本物と同じソース。
- facilitator は HTTP サーバーにせず、公式の `x402Facilitator` をリソースサーバーと同一プロセスで呼んでいる（間にログと故障注入を挟むため）。
- anvil には Multicall3 がないため、SDK の「失敗原因の診断」が働かず、エラー理由が汎用の `transaction_simulation_failed` になる場面がある。
- 自作ウォレットは EIP-712 ダイジェストに owner が直接署名する素朴な形式。実在のスマートウォレット（ハッシュを包み直すもの）とは違う。
- 「応答の喪失」は、settle 成功後に TCP ソケットを破棄して再現した。
- テーブルの `served` は**ハンドラーが実行された回数**。決済失敗時、本文はクライアントに渡っていない。

## 構成

```
contracts/src/RevocableWallet.sol  EIP-1271：owner を替えると過去の署名が全部無効になる
contracts/src/AgentWallet.sol      EIP-1271：エージェント用セッション鍵（支払先・金額・有効期間を検査）
                                   ＋対照用 CountingWallet（isValidSignature で状態を書こうとする）
lab/src/chain.ts                   anvil・USDC・ウォレットのデプロイ
lab/src/stack.ts                   公式SDKで組んだ facilitator / サーバー / クライアント＋故障注入
lab/src/exp0〜3-*.ts               実験
```

---

## 実験0：正常系（成立）

`GET /report` → 402 → EIP-712 署名 → verify → **handler 実行** → settle（`transferWithAuthorization`）→ 200。

- 買い手 −0.01 USDC、売り手 +0.01 USDC、nonce 消費済み、tx の送信者は facilitator。
- 実験1A では **ETH を 1 wei も持たないコントラクトウォレット**から支払えた。

最初の発見：`@x402/express` の順序は **verify → ハンドラー実行 → settle → 応答送信**。サービスは送金の確定より先に提供される（応答はバッファされ、settle 失敗時は捨てて 402 を返す）。

もう一つ：SDK クライアントは既定で、**SDK が知らないトークンへの支払いを拒否する**（`spendControls`）。ローカル USDC は `allowedAssets` に明示して許可した。

## 実験1：署名は正しいのに、支払えない

| ケース | HTTP | 提供 | 送金 | facilitator の tx | facilitator のガス |
| --- | --- | --- | --- | --- | --- |
| A 1271・対照 | 200 | 1 | 0.01 | 1 | 約10万gas分 |
| B 1271・verify 後に owner 交代 | 402 | 1 | 0 | **0** | 0 |
| C EOA・verify 後に `cancelAuthorization` | 402 | 1 | 0 | **0** | 0 |
| D 1271・settle tx 送信**後**、高いチップで owner 交代 | 402 | 1 | 0 | 1（revert） | **約5.2万gas分** |
| E EOA・settle tx 送信**後**、高いチップで `cancelAuthorization` | 402 | 1 | 0 | 1（revert） | **約3.4万gas分** |

観察：

1. **settle は署名を検証し直す**（`eip3009.ts`、EIP-1271 は厳格にオンチェーンで再確認）。B はここで止まり、tx は出ない。
2. ただし settle 時のシミュレーションは**既定で無効**（`simulateInSettle: false`）。C を止めたのは SDK の明示的な検査ではなく、viem の `writeContract` が送信前に行う**ガス見積り（`eth_estimateGas`）が revert したこと**。
3. 検証と送信の間をすり抜けた D・E では、tx はブロックに入って revert し、**facilitator がガス代だけを払った**。
4. **EIP-1271 固有ではない**。EOA でも EIP-3009 の `cancelAuthorization`（あるいは残高を動かすだけ）で同じことが起きる（C・E）。1271 の違いは「失効させる手段が鍵ローテーションのような正当な運用にも現れる」こと。
5. 全ケースでハンドラーは実行済み。**サービスの原価は売り手が負担**し、本文は渡していない。
6. USDC のソース自体が明言している：`contract signatures are revocable, and the outcome of this function can thus change through time. It could return true at block N and false at block N+1`（`contracts/util/SignatureChecker.sol`）。

> x402 仕様（`scheme_exact_evm.md`）は ERC-7710 の節で同じレースを「facilitator が失敗 tx のガスを払う」リスクとして記述している。EIP-3009 の節には同種の記述はない（今回 EIP-3009 でも起きることを確認）。

**攻撃と呼ぶ前に**：D・E で得をした者はいない。払い手は何も受け取っていない（本文は 402 で捨てられる）。被害は「売り手の計算資源」と「facilitator のガス」。サービスに外部副作用（メール送信、上流の有料 API 呼び出し等）があれば、そのコストは確定する。

## 実験2：同じものに二度払う

A〜F：最初の決済の直後に応答を1回だけ破棄。G〜I：破棄なし、同時送信。

| | 重複防止 | 再試行のしかた | 最終 | 支払い回数 | 提供 |
| --- | --- | --- | --- | --- | --- |
| A | なし | SDK で再リクエスト（新しい署名） | 200 | **2** | 2 |
| B | なし | 同じ署名を再送 | **402** | 1 | 1 |
| C | 公式 `payment-identifier` | 同じ署名を再送 | 200 | 1 | 1 |
| D | 公式 `payment-identifier` | 同じ id で SDK 再リクエスト（新しい署名） | **409** | 1 | 1 |
| D2 | 同上 | D の後、409 で断られた署名を**売り手が自分で実行** | 成功 | **2** | 1 |
| E | 公式 `payment-identifier` | 再起動：id も署名も作り直す | 200 | **2** | 2 |
| F | アプリの購入 ID（支払い前に照合） | 再起動：同じ購入 ID で再リクエスト | 200 | 1 | 1 |
| G | 同上（予約なし） | 応答を待たずに同じ購入 ID で並行送信 | 200/200 | **2** | 2 |
| H | 同上、facilitator が素の viem | G と同じ | 402/200 | 1 | **2** |
| I | 購入 ID ＋処理中の予約 | G と同じ | 409/200 | 1 | 1 |

観察：

1. **nonce が防ぐのは「同じ署名の再利用」だけ**（B）。しかし同じ署名で再試行すると、払ったのに何も受け取れない（402）。
2. SDK の素直な再試行は **402 を受け直して新しい署名を作る**＝別の送金（A）。`wrapFetchWithPayment` 自体は通信断を再試行しない（支払いは1リクエストにつき原則1回。フックが「回復した」と返した場合のみ、新しい署名でもう1回）。通信断の後に再試行するのは呼び出し側。
3. 公式の冪等性拡張 `payment-identifier` は、SDK としては**宣言と抽出の関数だけ**。重複判定のストアは実装者に任されている（`resourceServer.ts` に `// Future hooks for idempotency could be added here if needed`）。公式サンプルは**署名を含むペイロード全体**の指紋で照合するため、同じ id でも新しい署名だと 409（D）。二重払いは防ぐが、買い手は何も受け取れない。
4. **409 で断られた署名も、有効期限（`validBefore`）までは受け取った側が実行できる**（D2）。署名は持参人払いの小切手に近い。既定の期限は `maxTimeoutSeconds`（サーバーが指定。今回 120 秒）。
5. 「同じ購入」を表せるのは決済層ではなくアプリ層：購入 ID を**支払いより前に**、買い手と結びつけて照合すれば再起動をまたいでも1回で済む（F）。
6. ただし処理中の予約がないと、**同時送信で二重課金**（G）。予約を入れると解消（I）。これは Stripe 等の idempotency key と同じ問題で、ブロックチェーン固有ではない。
7. 副産物（H）：素の viem で tx を送る facilitator（公式 facilitator サンプルと同じ構成）は、並行 settle で **nonce が衝突**（`nonce too low`）。今回はそれが偶然二重課金を防いだが、ハンドラーは2回実行され、片方の買い手は 402 を受けた。
8. I でも、409 で断られた側は**既に署名を作り、サーバーに送っている**（402 → 署名はサーバーの予約より前に起きる）。4 と同じく、その署名は期限まで有効。

## 実験3：AI の財布と支出ポリシー

3つの層で同じシナリオを流した（支払った額 [各リクエストの結果]）。

- **L0 SDK 既定**：`spendControls`（1回あたり上限・トークン許可リスト。今回は 1 USDC/回）
- **L1 クライアント方針**：L0 ＋ `registerPolicy`（支払先許可リスト）＋ `onBeforePaymentCreation`（タスク予算 1 USDC、同一 URL の再購入禁止、署名有効期間 ≤ 600 秒）
- **L2 オンチェーン**：クライアント側は**何もしない**（`spendControls: false`）。`AgentWallet` のセッション鍵だけ（支払先許可リスト、0.5 USDC/回、有効期間 ≤ 600 秒、残高 1 USDC）。＝クライアントの制約が迂回された状況

| シナリオ | L0 SDK 既定 | L1 クライアント方針 | L2 オンチェーン |
| --- | --- | --- | --- |
| 1 正規の API・0.01 | 0.01 [200] | 0.01 [200] | 0.01 [200] |
| 2 知らない支払先 | **0.01** [200] | 0 [拒否] | 0 [402] |
| 3 正規の支払先が 0.9 を要求 | 0.90 [200] | 0.90 [200] | 0 [402] |
| 4 同じレポートを3回 | 0.03 | 0.01 [200,拒否,拒否] | **0.03** |
| 5 0.3 を別々に6回 | **1.80** | 0.90 [3回で予算切れ] | 0.90 [残高切れ] |
| 6 署名の有効期間 1 年を要求 | **0.01** [200] | 0 [拒否] | 0 [402] |

対照：`isValidSignature` の中で支出回数を書き込もうとする `CountingWallet` → **402、書き込みは 0 回**。トークンは `staticcall` で呼ぶので状態を書けない。興味深いのは、facilitator の署名検証（`eth_call` で直接 `isValidSignature` を呼ぶ＝static ではない）は**通り**、その後のシミュレーションで落ちたこと。

観察：

1. SDK 既定は「1回あたりの上限」と「トークンの種類」しか見ない。**支払先も、累積額も、重複も、署名の有効期間も見ない**（L0 の 2・5・6）。サーバーが `maxTimeoutSeconds` に1年を指定すれば、1年有効な署名がそのまま作られる。
2. `isValidSignature(bytes32 hash, bytes sig)` はハッシュしか受け取らないが、**署名バイト列に認可の中身（支払先・金額・期限）を同梱し、ウォレット側でハッシュを再計算**すれば、中身を検査できる。公式 SDK・本物の USDC 実装を無改造のまま通った。
3. オンチェーンで強制できたのは「支払先・1回の額・有効期間」と、**残高という形の累積上限**。`isValidSignature` は view なので、累積支出をカウントする方法はない（対照実験）。最も確実な予算は「それ以上を持たせないこと」（プリペイド）。
4. オンチェーンは「同じものを買った」を知らない（4）。購入の意味はクライアント／アプリの層にしかない。
5. L1 の制約は、エージェントが鍵を持つプロセス内のコードなので、別の経路で署名されれば迂回される。L2 は鍵（セッション鍵）が漏れても上の範囲に縛られる。ただし owner 鍵は何でもできる。

---

## まだやっていないこと

- LLM を接続したエージェント（プロンプトインジェクション、支払先のすり替えを誘導するツール応答）。今回は決定論的なクライアントのみ。
- EIP-7702、Permit2 経路、ERC-7710 経路。
- テストネット／実ネットワーク、実デプロイの USDC プロキシ。
- facilitator を HTTP で分離した構成、`settlement_pending` の経路。
- `simulateInSettle: true` にした場合、facilitator の signer がガス量を明示した場合の挙動（実験1Cの「ガス見積りが防いだ」部分が変わるはず。未検証）。
- `receiveWithAuthorization` との比較（企画メモ §7）。
- 既存決済 API（Stripe の idempotency key 等）との具体比較。
- upfront フロー（settle を先に行う方式）。
- `authorizationState` による支払いの確認（再試行前に署名が使われたかどうかを確かめる買い手）。
- Sign-In-With-X 拡張（ウォレットアドレスで買い手を識別し、購入済みリソースに再課金しない）。
- batch-settlement など exact 以外の方式。

## セットアップ（クローン後）

```sh
# 依存ソース（版は上表に固定）
git clone https://github.com/x402-foundation/x402.git vendor/x402 && git -C vendor/x402 checkout faa1c694c66a3732aaabbce93bdae140e521a67d
git clone https://github.com/circlefin/stablecoin-evm.git vendor/stablecoin-evm && git -C vendor/stablecoin-evm checkout fc85788bc7c23cefe3df1a757133048bfddadeaa
git clone --depth 1 -b v1.11.0 https://github.com/foundry-rs/forge-std.git contracts/lib/forge-std
(cd contracts && npm ci && forge build)
(cd lab && npm ci)
anvil --port 8545 &   # 別端末でも可
(cd lab && npm run all)
```

`vendor/x402` は SDK を読むための参照用で、実験の実行には npm の `@x402/*@2.28.0` を使う。
