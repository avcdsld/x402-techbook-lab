// 公式 SDK（@x402/* 2.28.0）で組んだ facilitator・リソースサーバー・クライアント。
// 実験のために差し込めるのは「フック」だけにして、SDK の処理そのものは書き換えない。
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme as FacilitatorExact } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ServerExact } from "@x402/evm/exact/server";
import { ExactEvmScheme as ClientExact } from "@x402/evm/exact/client";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  declarePaymentIdentifierExtension,
  appendPaymentIdentifierToExtensions,
  extractPaymentIdentifier,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";
import { hashTypedData, type Address, type Hex } from "viem";
import { NETWORK, pub, walletOf, who, withNonceManager, type World } from "./chain.js";

export const PRICE = "10000"; // 0.01 USDC（6 decimals）

// ---------------------------------------------------------------- journal
export type Entry = { t: number; who: string; what: string; [k: string]: unknown };
export const journal: Entry[] = [];
const t0 = Date.now();
export function note(who: string, what: string, data: Record<string, unknown> = {}) {
  const e = { t: Date.now() - t0, who, what, ...data };
  journal.push(e);
  if (!process.env.QUIET) console.log(`  [${String(e.t).padStart(5)}ms] ${who.padEnd(11)} ${what}`, Object.keys(data).length ? data : "");
}
export const short = (h?: string) => (h ? `${h.slice(0, 10)}…` : h);
/** 公式 payment-identifier サンプルと同じ正規化 JSON の SHA-256 */
function fingerprint(payload: PaymentPayload): string {
  const canonical = JSON.stringify(payload, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v,
  );
  return createHash("sha256").update(canonical).digest("hex");
}
const digest = (p: PaymentPayload) => createHash("sha256").update(JSON.stringify(p.payload)).digest("hex").slice(0, 12);

// ---------------------------------------------------------------- facilitator
export type Hooks = {
  /** verify と settle の間（リソースサーバーが handler を実行した後）に呼ばれる */
  beforeSettle?: (p: PaymentPayload) => Promise<void>;
  /** facilitator が settle tx をブロードキャストした直後に呼ばれる */
  afterBroadcast?: (tx: Hex) => Promise<void>;
  /** facilitator の送信アカウントに nonceManager を付けるか（既定：付けない＝公式サンプルと同じ素の viem） */
  facilitatorNonceManager?: boolean;
};

export function makeFacilitator(hooks: Hooks): FacilitatorClient {
  const w = walletOf(hooks.facilitatorNonceManager ? withNonceManager(1) : who.facilitator);
  const signer = toFacilitatorEvmSigner({
    address: who.facilitator.address,
    getCode: a => w.getCode(a),
    readContract: a => w.readContract({ ...a, args: a.args ?? [] } as never),
    verifyTypedData: a => w.verifyTypedData(a as never),
    writeContract: async a => {
      const tx = await w.writeContract({ ...a, args: a.args ?? [] } as never);
      note("facilitator", "settle tx を送信", { tx: short(tx) });
      await hooks.afterBroadcast?.(tx);
      return tx;
    },
    sendTransaction: a => w.sendTransaction(a),
    waitForTransactionReceipt: a => w.waitForTransactionReceipt(a),
  });
  const f = new x402Facilitator().register(NETWORK, new FacilitatorExact(signer));

  return {
    async verify(p: PaymentPayload, r: PaymentRequirements) {
      const res = await f.verify(p, r);
      note("facilitator", "verify", { sig: digest(p), isValid: res.isValid, reason: res.invalidReason });
      return res;
    },
    async settle(p: PaymentPayload, r: PaymentRequirements) {
      await hooks.beforeSettle?.(p);
      const res = await f.settle(p, r);
      note("facilitator", "settle", {
        sig: digest(p),
        success: res.success,
        tx: short(res.transaction),
        reason: res.errorReason,
        message: res.errorMessage?.split("\n").find(l => /reason|reverted|Details/i.test(l))?.trim(),
      });
      return res;
    },
    async getSupported() {
      return f.getSupported();
    },
  } as FacilitatorClient;
}

// ---------------------------------------------------------------- resource server
export type ServerOpts = Hooks & {
  /** true なら、次の決済後の応答を一度だけ TCP ごと捨てる（クライアントからは通信断に見える） */
  dropResponse?: { on: boolean };
  /**
   * 重複防止（実験2）
   * - "payment-identifier": 公式拡張。クライアントが付けた id と、署名を含むペイロード全体の指紋で照合
   * - "purchase-id-naive": アプリ側の購入 ID を、支払いより前に（認証済みの）買い手と結びつけて照合
   * - "purchase-id": 上に加えて、処理中の購入 ID を予約しておき、並行する同じ購入を 409 で断る
   */
  idempotency?: "payment-identifier" | "purchase-id-naive" | "purchase-id";
  /** 支払い条件（実験3で、悪意あるAPIを作るために変える） */
  price?: string;
  payTo?: Address;
  maxTimeoutSeconds?: number;
};

export type Running = { url: string; executions: () => number; close: () => Promise<void> };

export async function startServer(world: World, opts: ServerOpts = {}): Promise<Running> {
  const app = express();
  let executions = 0;
  const done = new Map<string, { fingerprint: string; body: unknown }>(); // 決済済みの購入
  const inFlight = new Set<string>(); // 処理中の購入

  // 故障注入：paymentMiddleware より前に res.end を差し替えておく。
  // ミドルウェアは settle 成功後に「元の」res.end を呼ぶので、そこで接続を切る。
  app.use((req, res, next) => {
    const rid = randomUUID().slice(0, 8);
    (req as any).rid = rid;
    const end = res.end.bind(res);
    res.end = ((...args: unknown[]) => {
      // 決済が成立した（PAYMENT-RESPONSE が付いた 200）時点で購入を記録する
      const key = (req as any).idemKey;
      if (key && res.statusCode === 200 && res.getHeader("PAYMENT-RESPONSE"))
        done.set(key, { fingerprint: (req as any).idemFp, body: (req as any).body402 });
      if (opts.dropResponse?.on && res.statusCode === 200) {
        opts.dropResponse.on = false;
        note("server", "!! 決済後の応答を破棄（socket destroy）", { rid });
        req.socket.destroy();
        return res;
      }
      note("server", `→ HTTP ${res.statusCode}`, { rid, paymentResponse: !!res.getHeader("PAYMENT-RESPONSE") });
      return end(...(args as Parameters<typeof end>));
    }) as typeof res.end;
    note("server", `← ${req.method} ${req.url}`, {
      rid,
      purchaseId: req.get("Purchase-Id"),
      paid: !!req.get("PAYMENT-SIGNATURE"),
    });
    next();
  });

  // 実験2の対策：支払いの処理より前に、同じ購入かどうかを照合する
  if (opts.idempotency) {
    app.use("/report", (req, res, next) => {
      let key: string | undefined, fp: string;
      if (opts.idempotency !== "payment-identifier") {
        const id = req.get("Purchase-Id");
        const buyer = req.get("Buyer"); // 本来は認証済みの主体。実験では簡略化
        if (!id || !buyer) return res.status(400).json({ error: "Purchase-Id and Buyer required" });
        key = `${buyer}:${id}`;
        fp = `${req.method} ${req.originalUrl}`;
      } else {
        const header = req.get("PAYMENT-SIGNATURE");
        if (!header) return next();
        const payload = decodePaymentSignatureHeader(header);
        key = extractPaymentIdentifier(payload) ?? undefined;
        fp = fingerprint(payload); // 公式サンプルと同じく、署名を含むペイロード全体
      }
      if (!key) return next();
      const hit = done.get(key);
      if (hit && hit.fingerprint !== fp) {
        note("server", "同じ id で別の内容 → 409", { key: key.slice(0, 24) });
        return res.status(409).json({ error: "id reused for different request" });
      }
      if (hit) {
        note("server", "購入済み：支払いを処理せず同じ結果を返す", { key: key.slice(0, 24) });
        return res.json(hit.body);
      }
      if (opts.idempotency === "purchase-id") {
        if (inFlight.has(key)) {
          note("server", "同じ購入を処理中 → 409", { key: key.slice(0, 24) });
          return res.status(409).json({ error: "purchase in progress" });
        }
        inFlight.add(key);
        res.on("close", () => inFlight.delete(key!));
      }
      (req as any).idemKey = key;
      (req as any).idemFp = fp;
      next();
    });
  }

  const resourceServer = new x402ResourceServer(makeFacilitator(opts)).register(NETWORK, new ServerExact());
  app.use(
    paymentMiddleware(
      {
        "GET /report": {
          accepts: [
            {
              scheme: "exact",
              network: NETWORK,
              payTo: opts.payTo ?? who.seller.address,
              price: { amount: opts.price ?? PRICE, asset: world.usdc, extra: { name: "USD Coin", version: "2" } },
              maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 120,
            },
          ],
          description: "有料レポート",
          mimeType: "application/json",
          extensions:
            opts.idempotency === "payment-identifier"
              ? { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) }
              : undefined,
        },
      },
      resourceServer,
    ),
  );

  app.get("/report", (req, res) => {
    executions++;
    const body = { report: `report #${executions}`, q: req.query.q ?? null };
    note("server", "handler 実行（=サービス提供）", { n: executions });
    (req as any).body402 = body;
    res.json(body);
  });

  const server: Server = await new Promise(ok => {
    const s = app.listen(0, () => ok(s));
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    executions: () => executions,
    close: () =>
      new Promise(ok => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

// ---------------------------------------------------------------- client
/** EOA の買い手 */
export function eoaSigner(): ClientEvmSigner {
  return who.buyer as unknown as ClientEvmSigner;
}

/** EIP-1271 ウォレットの買い手。owner 鍵で EIP-712 ダイジェストに直接署名する */
export function walletSigner(wallet: Address, owner = who.walletOwnerA): ClientEvmSigner {
  return {
    address: wallet,
    signTypedData: async td => owner.sign!({ hash: hashTypedData(td as never) }),
  };
}

export function makeClient(
  signer: ClientEvmSigner,
  usdc: Address,
  opts: { paymentId?: string; spendControls?: false; configure?: (c: x402Client) => void } = {},
) {
  const client = new x402Client();
  if (opts.paymentId)
    client.onBeforePaymentCreation(async ({ paymentRequired }) => {
      if (paymentRequired.extensions) appendPaymentIdentifierToExtensions(paymentRequired.extensions, opts.paymentId);
    });
  // 既定ではSDKが知っているトークン以外への支払いを拒否する。ローカルUSDCを明示的に許可（上限 1 USDC/回）
  client.setSpendControls(
    opts.spendControls ?? { allowedAssets: [{ network: NETWORK, asset: usdc, maxAmountPerPayment: "1000000" }] },
  );
  opts.configure?.(client);
  client.register("eip155:*", new ClientExact(signer));
  const signed: PaymentPayload[] = [];
  client.onAfterPaymentCreation(async ({ paymentPayload }) => {
    signed.push(paymentPayload);
    const a = (paymentPayload.payload as any).authorization;
    note("client", "署名を作成", { sig: digest(paymentPayload), nonce: short(a.nonce), value: a.value, to: short(a.to) });
  });
  /** 直前に作った支払いヘッダーをそのまま再送する（同じ署名による再試行） */
  const replay = (url: string, i = signed.length - 1, headers: Record<string, string> = {}) =>
    fetch(url, { headers: { ...headers, ...new x402HTTPClient(client).encodePaymentSignatureHeader(signed[i]) } });
  return { client, signed, replay, fetch: wrapFetchWithPayment(fetch, client) };
}

export async function blockInfo() {
  const b = await pub.getBlock();
  return { block: Number(b.number), ts: Number(b.timestamp) };
}

export type { Hex };
