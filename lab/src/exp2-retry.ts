// 実験2：決済は成立したのに応答が届かない。そのあと再試行すると何回払うか
import { randomUUID } from "node:crypto";
import { balanceOf, pub, setupWorld, usdcArtifact, walletOf, who } from "./chain.js";
import { PRICE, eoaSigner, makeClient, note, startServer, type ServerOpts } from "./stack.js";

type Row = { case: string; idempotency: string; retry: string; final: string; payments: number; served: number };
const rows: Row[] = [];

async function attempt(label: string, p: () => Promise<Response>) {
  try {
    const r = await p();
    const text = await r.text();
    note("client", `${label}: HTTP ${r.status}`, { body: text.slice(0, 60) });
    return `${r.status}`;
  } catch (e) {
    note("client", `${label}: 通信断`, { error: String((e as Error).cause ?? e).slice(0, 60) });
    return "通信断";
  }
}

async function scenario(
  name: string,
  idempotency: ServerOpts["idempotency"],
  retry: string,
  body: (ctx: { url: string; mk: typeof makeClient; usdc: `0x${string}` }) => Promise<string>,
  extra: ServerOpts = { dropResponse: { on: true } },
) {
  console.log(`\n=== ${name}`);
  const world = await setupWorld();
  const server = await startServer(world, { idempotency, ...extra });
  const s0 = await balanceOf(world.usdc, who.seller.address);
  const final = await body({ url: `${server.url}/report`, mk: makeClient, usdc: world.usdc });
  const paid = (await balanceOf(world.usdc, who.seller.address)) - s0;
  rows.push({ case: name, idempotency: idempotency ?? "なし", retry, final, payments: Number(paid / BigInt(PRICE)), served: server.executions() });
  await server.close();
}

// A: 対策なし。SDK をもう一度呼ぶ（= 402 を受けて新しい署名を作る）
await scenario("A", undefined, "SDKで再リクエスト（新しい署名）", async ({ url, usdc }) => {
  const c = makeClient(eoaSigner(), usdc);
  await attempt("1回目", () => c.fetch(url));
  return attempt("再試行", () => c.fetch(url));
});

// B: 対策なし。同じ署名ヘッダーを再送
await scenario("B", undefined, "同じ署名を再送", async ({ url, usdc }) => {
  const c = makeClient(eoaSigner(), usdc);
  await attempt("1回目", () => c.fetch(url));
  return attempt("再試行", () => c.replay(url));
});

// C: 公式 payment-identifier。同じ署名ヘッダー（= 同じ id）を再送
await scenario("C", "payment-identifier", "同じ署名を再送", async ({ url, usdc }) => {
  const c = makeClient(eoaSigner(), usdc, { paymentId: `pay_${randomUUID().replaceAll("-", "")}` });
  await attempt("1回目", () => c.fetch(url));
  return attempt("再試行", () => c.replay(url));
});

// D: 公式 payment-identifier。同じ id のまま SDK で再リクエスト（新しい署名）
await scenario("D", "payment-identifier", "同じidでSDK再リクエスト（新しい署名）", async ({ url, usdc }) => {
  const c = makeClient(eoaSigner(), usdc, { paymentId: `pay_${randomUUID().replaceAll("-", "")}` });
  await attempt("1回目", () => c.fetch(url));
  return attempt("再試行", () => c.fetch(url));
});

// D2: D のあと、409 で断られた署名を受け取った側（ここでは売り手）が自分で送金を実行する
await scenario("D2", "payment-identifier", "Dのあと、409で断られた署名を売り手が実行", async ({ url, usdc }) => {
  const c = makeClient(eoaSigner(), usdc, { paymentId: `pay_${randomUUID().replaceAll("-", "")}` });
  await attempt("1回目", () => c.fetch(url));
  const final = await attempt("再試行", () => c.fetch(url));
  const { authorization: a, signature } = c.signed[1].payload as any;
  const hash = await walletOf(who.seller).writeContract({
    address: usdc,
    abi: usdcArtifact.abi,
    functionName: "transferWithAuthorization",
    args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, signature],
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  note("seller", "409 で断った署名を自分で実行", { status: r.status, validBefore: a.validBefore });
  return `${final}→売り手が実行:${r.status}`;
});

// E: 公式 payment-identifier。クライアントが再起動して id も署名も作り直す
await scenario("E", "payment-identifier", "再起動：新しいidと新しい署名", async ({ url, usdc }) => {
  await attempt("1回目", () => makeClient(eoaSigner(), usdc, { paymentId: `pay_${randomUUID().replaceAll("-", "")}` }).fetch(url));
  return attempt("再試行", () => makeClient(eoaSigner(), usdc, { paymentId: `pay_${randomUUID().replaceAll("-", "")}` }).fetch(url));
});

// F: アプリ層の購入 ID（支払いより前に照合）。再起動して SDK で再リクエスト
await scenario("F", "purchase-id-naive", "再起動：同じ購入IDでSDK再リクエスト", async ({ url, usdc }) => {
  const h = { "Purchase-Id": "order-42", Buyer: who.buyer.address };
  await attempt("1回目", () => makeClient(eoaSigner(), usdc).fetch(url, { headers: h }));
  return attempt("再試行", () => makeClient(eoaSigner(), usdc).fetch(url, { headers: h }));
});

// G: 購入 ID・応答喪失なし。二つのリクエストが同時に飛ぶ（応答を待たずに再送した場合）
const concurrent = (orderId: string) => async ({ url, usdc }: { url: string; usdc: `0x${string}` }) => {
  const h = { "Purchase-Id": orderId, Buyer: who.buyer.address };
  const c = makeClient(eoaSigner(), usdc);
  const [a, b] = await Promise.all([attempt("並行1", () => c.fetch(url, { headers: h })), attempt("並行2", () => c.fetch(url, { headers: h }))]);
  return `${a}/${b}`;
};
await scenario("G", "purchase-id-naive", "応答を待たずに同じ購入IDで並行送信", concurrent("order-43"), { facilitatorNonceManager: true });

// H: G と同じだが facilitator が素の viem（公式 facilitator サンプルと同じ構成）
await scenario("H", "purchase-id-naive", "Gと同じ／facilitatorにnonce管理なし", concurrent("order-44"), {});
// I: G と同じだが、購入 ID を処理中から予約する
await scenario("I", "purchase-id", "Gと同じ／購入IDを処理中に予約", concurrent("order-45"), { facilitatorNonceManager: true });

console.log("\n=== まとめ（A〜F は最初の決済後の応答を1回だけ破棄。G〜I は破棄なし）");
console.table(rows);
