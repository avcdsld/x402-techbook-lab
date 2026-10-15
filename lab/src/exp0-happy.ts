// 実験0：正常系。402 → 署名 → verify → handler → settle → 200 を一件通す
import assert from "node:assert/strict";
import { authorizationUsed, balanceOf, who, setupWorld } from "./chain.js";
import { PRICE, blockInfo, eoaSigner, makeClient, note, startServer } from "./stack.js";

const world = await setupWorld();
const server = await startServer(world);
const { fetch: payFetch, signed } = makeClient(eoaSigner(), world.usdc);

const before = { buyer: await balanceOf(world.usdc, who.buyer.address), seller: await balanceOf(world.usdc, who.seller.address) };
note("chain", "開始時", { ...(await blockInfo()), ...before });

const res = await payFetch(`${server.url}/report`);
const body = await res.json();
const receipt = JSON.parse(Buffer.from(res.headers.get("PAYMENT-RESPONSE")!, "base64").toString());
note("client", `HTTP ${res.status}`, { body, receipt });

const after = { buyer: await balanceOf(world.usdc, who.buyer.address), seller: await balanceOf(world.usdc, who.seller.address) };
const auth = (signed[0].payload as any).authorization;
note("chain", "終了時", { ...(await blockInfo()), ...after, nonceUsed: await authorizationUsed(world.usdc, auth.from, auth.nonce) });

assert.equal(res.status, 200);
assert.equal(before.buyer - after.buyer, BigInt(PRICE));
assert.equal(after.seller - before.seller, BigInt(PRICE));
assert.equal(server.executions(), 1);
assert.equal(await authorizationUsed(world.usdc, auth.from, auth.nonce), true);
const tx = await (await import("./chain.js")).pub.getTransaction({ hash: receipt.transaction });
note("chain", "tx の送信者はだれか", { from: tx.from, facilitator: who.facilitator.address, buyer: who.buyer.address });
assert.equal(tx.from.toLowerCase(), who.facilitator.address.toLowerCase());

console.log("\n実験0 OK: 署名1回・送金1回・提供1回。ガス代は facilitator が払った");
await server.close();
