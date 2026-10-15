// 実験3：AIに財布を持たせる。どの層の制約が、どの失敗を止めるか
//
// 層
//   L0  SDK の既定（spendControls：1回あたりの上限・トークンの許可リスト）
//   L1  L0 + クライアントの独自ポリシー（支払先許可リスト・タスク予算・重複購入・署名の有効期間）
//   L2  クライアント側は何もしない。オンチェーンの AgentWallet（セッション鍵）だけ
import { encodeAbiParameters, hashTypedData, type Address } from "viem";
import type { ClientEvmSigner } from "@x402/evm";
import type { x402Client } from "@x402/fetch";
import { artifact, balanceOf, deploy, pub, setupWorld, usdcArtifact, walletOf, who, type World } from "./chain.js";
import { makeClient, note, startServer, type Running } from "./stack.js";

const USDC = (n: number) => String(Math.round(n * 1e6));

// ------------------------------------------------------------- AgentWallet
const agentArtifact = artifact("AgentWallet.sol", "AgentWallet");
const countingArtifact = artifact("AgentWallet.sol", "CountingWallet");

async function deployAgentWallet(world: World, budget: bigint) {
  const wallet = await deploy(agentArtifact.abi, agentArtifact.bytecode, [who.human.address, world.usdc]);
  const h = walletOf(who.human);
  const call = async (functionName: string, args: unknown[]) =>
    pub.waitForTransactionReceipt({ hash: await h.writeContract({ address: wallet, abi: agentArtifact.abi, functionName, args }) });
  await call("setSession", [who.agentKey.address, BigInt(USDC(0.5)), 600n]); // 1回 0.5 USDC まで・署名は10分以内
  await call("setPayee", [who.seller.address, true]);
  // 予算 = 残高。人間の財布から必要な分だけ移す
  const admin = walletOf(who.admin);
  await pub.waitForTransactionReceipt({
    hash: await admin.writeContract({ address: world.usdc, abi: usdcArtifact.abi, functionName: "mint", args: [wallet, budget] }),
  });
  return wallet;
}

/** セッション鍵の署名に、認可の中身を同梱する */
function sessionSigner(wallet: Address): ClientEvmSigner {
  return {
    address: wallet,
    async signTypedData(td) {
      const hash = hashTypedData(td as never);
      const inner = await who.agentKey.sign!({ hash });
      const m = td.message as any;
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
              { name: "nonce", type: "bytes32" },
            ],
          },
          { type: "bytes" },
        ],
        [m, inner],
      );
    },
  };
}

// ------------------------------------------------------------- client policy (L1)
function clientPolicy(c: x402Client) {
  const allowedPayees = new Set([who.seller.address.toLowerCase()]);
  const budget = BigInt(USDC(1));
  let committed = 0n; // 署名した時点で使ったとみなす（署名は期限まで実行されうるため）
  const bought = new Set<string>();

  c.registerPolicy((_v, reqs) => reqs.filter(r => allowedPayees.has(r.payTo.toLowerCase())));
  c.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements: r }) => {
    const url = paymentRequired.resource?.url ?? "";
    if (r.maxTimeoutSeconds > 600) return { abort: true, reason: `署名の有効期間が長すぎる（${r.maxTimeoutSeconds}s）` };
    if (bought.has(url)) return { abort: true, reason: `同じものを購入済み ${url}` };
    if (committed + BigInt(r.amount) > budget) return { abort: true, reason: `タスク予算超過（${committed}+${r.amount}>${budget}）` };
    committed += BigInt(r.amount);
    bought.add(url);
  });
}

// ------------------------------------------------------------- scenarios
type Scenario = {
  name: string;
  server: { price?: string; payTo?: Address; maxTimeoutSeconds?: number };
  requests: string[]; // クエリ
};

const scenarios: Scenario[] = [
  { name: "1 正規のAPI・0.01 USDC", server: {}, requests: ["a"] },
  { name: "2 知らない支払先（すり替えられたAPI）", server: { payTo: who.attacker.address }, requests: ["a"] },
  { name: "3 正規の支払先が 0.9 USDC を要求", server: { price: USDC(0.9) }, requests: ["a"] },
  { name: "4 同じレポートを3回買う", server: {}, requests: ["a", "a", "a"] },
  { name: "5 0.3 USDC を別々に6回", server: { price: USDC(0.3) }, requests: ["a", "b", "c", "d", "e", "f"] },
  { name: "6 署名の有効期間 1年を要求", server: { maxTimeoutSeconds: 365 * 24 * 3600 }, requests: ["a"] },
];

type Layer = "L0 SDK既定" | "L1 クライアント方針" | "L2 オンチェーン";
const layers: Layer[] = ["L0 SDK既定", "L1 クライアント方針", "L2 オンチェーン"];
const matrix: Record<string, Record<string, string>> = {};

for (const sc of scenarios) {
  matrix[sc.name] = {};
  for (const layer of layers) {
    console.log(`\n=== ${sc.name} / ${layer}`);
    const world = await setupWorld();
    const server: Running = await startServer(world, sc.server);
    let payer: Address;
    let client;
    if (layer === "L2 オンチェーン") {
      payer = await deployAgentWallet(world, BigInt(USDC(1)));
      client = makeClient(sessionSigner(payer), world.usdc, { spendControls: false });
    } else {
      payer = who.buyer.address;
      client = makeClient(who.buyer as unknown as ClientEvmSigner, world.usdc, {
        configure: layer === "L1 クライアント方針" ? clientPolicy : undefined,
      });
    }
    const b0 = await balanceOf(world.usdc, payer);
    const outcomes: string[] = [];
    for (const q of sc.requests) {
      try {
        const r = await client.fetch(`${server.url}/report?q=${q}`);
        outcomes.push(String(r.status));
        note("agent", `q=${q} → HTTP ${r.status}`);
      } catch (e) {
        const msg = String((e as Error).message);
        outcomes.push("拒否");
        note("agent", `q=${q} → クライアントで拒否`, { msg: msg.replace(/^Failed to create payment payload: /, "").slice(0, 90) });
      }
    }
    const spent = b0 - (await balanceOf(world.usdc, payer));
    matrix[sc.name][layer] = `${(Number(spent) / 1e6).toFixed(2)} USDC [${outcomes.join(",")}]`;
    await server.close();
  }
}

// ------------------------------------------------------------- 対照：isValidSignature で状態を書こうとする
console.log("\n=== 対照：CountingWallet（isValidSignature の中で支出回数を書き込む）");
{
  const world = await setupWorld();
  const server = await startServer(world);
  const wallet = await deploy(countingArtifact.abi, countingArtifact.bytecode, [who.human.address]);
  await pub.waitForTransactionReceipt({
    hash: await walletOf(who.admin).writeContract({ address: world.usdc, abi: usdcArtifact.abi, functionName: "mint", args: [wallet, 1_000_000n] }),
  });
  const signer: ClientEvmSigner = { address: wallet, signTypedData: async td => who.human.sign!({ hash: hashTypedData(td as never) }) };
  const r = await makeClient(signer, world.usdc).fetch(`${server.url}/report`);
  note("agent", `HTTP ${r.status}`, {
    spentCount: await pub.readContract({ address: wallet, abi: countingArtifact.abi, functionName: "spentCount" }),
    balance: await balanceOf(world.usdc, wallet),
  });
  await server.close();
}

console.log("\n=== まとめ（支払った額 [各リクエストの結果]）");
console.table(matrix);
