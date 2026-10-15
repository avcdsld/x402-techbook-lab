// 実験1：verify を通った支払いが、settle の時点で払えなくなる
//
//  A. EIP-1271 ウォレット・何もしない                      （対照）
//  B. EIP-1271 ウォレット・verify と settle の間に owner を交代
//  C. EOA・verify と settle の間に cancelAuthorization
//  D. EIP-1271 ウォレット・owner 交代 tx が mempool で待っている間に settle
import assert from "node:assert/strict";
import type { Address } from "viem";
import { authorizationUsed, balanceOf, pub, setupWorld, test, usdcArtifact, walletArtifact, walletOf, who, type World } from "./chain.js";
import { eoaSigner, makeClient, note, startServer, walletSigner, type Hooks } from "./stack.js";

type Result = { case: string; http: number; served: number; paid: bigint; nonceUsed: boolean; facilitatorGasWei: bigint; facilitatorTxs: number };
const results: Result[] = [];

async function run(name: string, world: World, payer: Address, signer: Parameters<typeof makeClient>[0], hooks: Hooks) {
  console.log(`\n=== ${name}`);
  const server = await startServer(world, hooks);
  const { fetch: payFetch, signed } = makeClient(signer, world.usdc);
  const bal0 = await balanceOf(world.usdc, payer);
  const eth0 = await pub.getBalance({ address: who.facilitator.address });
  const n0 = await pub.getTransactionCount({ address: who.facilitator.address });

  let status = 0;
  try {
    const res = await payFetch(`${server.url}/report`);
    status = res.status;
    note("client", `HTTP ${res.status}`, { body: await res.text() });
  } catch (e) {
    note("client", "例外", { e: String(e) });
  }
  const auth = (signed[0].payload as any).authorization;
  const r: Result = {
    case: name,
    http: status,
    served: server.executions(),
    paid: bal0 - (await balanceOf(world.usdc, payer)),
    nonceUsed: await authorizationUsed(world.usdc, auth.from, auth.nonce),
    facilitatorGasWei: eth0 - (await pub.getBalance({ address: who.facilitator.address })),
    facilitatorTxs: (await pub.getTransactionCount({ address: who.facilitator.address })) - n0,
  };
  results.push(r);
  await server.close();
  return r;
}

const rotate = async (wallet: Address, from = who.walletOwnerA, to = who.walletOwnerB) => {
  const w = walletOf(from);
  return w.writeContract({ address: wallet, abi: walletArtifact.abi, functionName: "rotateOwner", args: [to.address] });
};

// ---- A
{
  const world = await setupWorld();
  const r = await run("A. 1271・対照", world, world.wallet, walletSigner(world.wallet), {});
  assert.deepEqual([r.http, r.served, r.paid], [200, 1, 10000n]);
}

// ---- B
{
  const world = await setupWorld();
  const r = await run("B. 1271・verify後にowner交代", world, world.wallet, walletSigner(world.wallet), {
    beforeSettle: async () => {
      const hash = await rotate(world.wallet);
      await pub.waitForTransactionReceipt({ hash });
      note("wallet", "owner を交代した（鍵ローテーション）");
    },
  });
  assert.equal(r.served, 1);
  assert.equal(r.paid, 0n);
}

// ---- C
{
  const world = await setupWorld();
  const r = await run("C. EOA・verify後にcancelAuthorization", world, who.buyer.address, eoaSigner(), {
    beforeSettle: async p => {
      const a = (p.payload as any).authorization;
      const sig = await who.buyer.signTypedData({
        domain: { name: "USD Coin", version: "2", chainId: 31337, verifyingContract: world.usdc },
        types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "CancelAuthorization",
        message: { authorizer: who.buyer.address, nonce: a.nonce },
      });
      const hash = await walletOf(who.buyer).writeContract({
        address: world.usdc,
        abi: usdcArtifact.abi,
        functionName: "cancelAuthorization",
        args: [who.buyer.address, a.nonce, sig],
      });
      await pub.waitForTransactionReceipt({ hash });
      note("buyer", "cancelAuthorization を送った（nonce を消費）");
    },
  });
  assert.equal(r.served, 1);
  assert.equal(r.paid, 0n);
}

// ---- D
{
  const world = await setupWorld();
  const r = await run("D. 1271・settle tx送信後に、より高いチップでowner交代", world, world.wallet, walletSigner(world.wallet), {
    beforeSettle: async () => {
      await test.setAutomine(false); // facilitator の tx をすぐには採掘させない
    },
    afterBroadcast: async () => {
      await walletOf(who.walletOwnerA).writeContract({
        address: world.wallet,
        abi: walletArtifact.abi,
        functionName: "rotateOwner",
        args: [who.walletOwnerB.address],
        gas: 200_000n, // 見積りを省く（pending の settle tx を前提に見積もると revert するため）
        maxPriorityFeePerGas: 50_000_000_000n,
        maxFeePerGas: 100_000_000_000n,
      });
      note("wallet", "より高いチップで owner 交代 tx を投入");
      await test.mine({ blocks: 1 });
      await test.setAutomine(true);
      const block = await pub.getBlock({ includeTransactions: true });
      note("chain", "1ブロック採掘", { order: block.transactions.map(t => `${t.from.slice(0, 6)}… nonce${t.nonce}`) });
    },
  });
  assert.equal(r.served, 1);
  assert.equal(r.paid, 0n);
}

// ---- E（D の EOA 版）
{
  const world = await setupWorld();
  let nonce: `0x${string}` = "0x";
  const r = await run("E. EOA・settle tx送信後に、より高いチップでcancelAuthorization", world, who.buyer.address, eoaSigner(), {
    beforeSettle: async p => {
      nonce = (p.payload as any).authorization.nonce;
      await test.setAutomine(false);
    },
    afterBroadcast: async () => {
      const sig = await who.buyer.signTypedData({
        domain: { name: "USD Coin", version: "2", chainId: 31337, verifyingContract: world.usdc },
        types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "CancelAuthorization",
        message: { authorizer: who.buyer.address, nonce },
      });
      await walletOf(who.buyer).writeContract({
        address: world.usdc,
        abi: usdcArtifact.abi,
        functionName: "cancelAuthorization",
        args: [who.buyer.address, nonce, sig],
        gas: 200_000n, // 見積りを省く（pending の settle tx を前提に見積もると revert するため）
        maxPriorityFeePerGas: 50_000_000_000n,
        maxFeePerGas: 100_000_000_000n,
      });
      note("buyer", "より高いチップで cancelAuthorization を投入");
      await test.mine({ blocks: 1 });
      await test.setAutomine(true);
      const block = await pub.getBlock({ includeTransactions: true });
      note("chain", "1ブロック採掘", { order: block.transactions.map(t => `${t.from.slice(0, 6)}… nonce${t.nonce}`) });
    },
  });
  assert.equal(r.served, 1);
  assert.equal(r.paid, 0n);
}

console.log("\n=== まとめ");
console.table(results.map(r => ({ ...r, paid: String(r.paid), facilitatorGasWei: String(r.facilitatorGasWei) })));
