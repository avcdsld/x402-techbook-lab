// ローカルEVM（anvil）と、その上に置く本物の USDC 実装・EIP-1271 ウォレット
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  publicActions,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount, nonceManager } from "viem/accounts";

export const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
export const NETWORK = "eip155:31337" as const;

export const anvil = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
/** 同じ鍵で、viem の nonceManager（送信中の tx の nonce をローカルで払い出す）付きのアカウント */
export const withNonceManager = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i, nonceManager });

/** 登場人物 */
export const who = {
  admin: acct(0), // USDC の各種ロール
  facilitator: acct(1), // ガス代を払って settle する
  seller: acct(2), // payTo
  buyer: acct(3), // EOA の買い手
  walletOwnerA: acct(4), // スマートウォレットの最初の owner
  walletOwnerB: acct(5), // ローテーション後の owner
  attacker: acct(6), // 悪意ある API の payTo
  human: acct(7), // エージェント用ウォレットの持ち主
  agentKey: acct(8), // エージェントに渡すセッション鍵
};

export const pub = createPublicClient({ chain: anvil, transport: http(RPC), pollingInterval: 50, cacheTime: 0 });
export const test = createTestClient({ chain: anvil, mode: "anvil", transport: http(RPC) });
export const walletOf = (a: ReturnType<typeof acct>) =>
  createWalletClient({ account: a, chain: anvil, transport: http(RPC), pollingInterval: 50, cacheTime: 0 }).extend(publicActions);

const OUT = new URL("../../contracts/out/", import.meta.url);
export function artifact(file: string, name: string) {
  const j = JSON.parse(readFileSync(new URL(`${file}/${name}.json`, OUT), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex, links: j.bytecode.linkReferences };
}

export const usdcArtifact = artifact("FiatTokenV2_2.sol", "FiatTokenV2_2");
export const walletArtifact = artifact("RevocableWallet.sol", "RevocableWallet");
const checkerArtifact = artifact("SignatureChecker.sol", "SignatureChecker");

function link(bytecode: Hex, links: Record<string, Record<string, { start: number; length: number }[]>>, addr: Address): Hex {
  let code = bytecode.slice(2);
  for (const lib of Object.values(links))
    for (const refs of Object.values(lib))
      for (const { start, length } of refs)
        code = code.slice(0, start * 2) + addr.slice(2).toLowerCase() + code.slice((start + length) * 2);
  return `0x${code}`;
}

export async function deploy(abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> {
  const w = walletOf(who.admin);
  const hash = await w.deployContract({ abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return getAddress(r.contractAddress!);
}

export type World = { usdc: Address; wallet: Address };

/** USDC（FiatTokenV2_2）とウォレットを新規デプロイし、買い手に 10 USDC ずつ配る */
export async function setupWorld(): Promise<World> {
  await test.setAutomine(true);
  const admin = walletOf(who.admin);
  const send = async (address: Address, abi: Abi, functionName: string, args: unknown[]) =>
    pub.waitForTransactionReceipt({ hash: await admin.writeContract({ address, abi, functionName, args }) });

  const checker = await deploy(checkerArtifact.abi, checkerArtifact.bytecode);
  const usdc = await deploy(usdcArtifact.abi, link(usdcArtifact.bytecode, usdcArtifact.links, checker));
  const a = who.admin.address;
  const { abi } = usdcArtifact;
  await send(usdc, abi, "initialize", ["USD Coin", "USDC", "USD", 6, a, a, a, a]);
  await send(usdc, abi, "initializeV2", ["USD Coin"]);
  await send(usdc, abi, "initializeV2_1", [a]);
  await send(usdc, abi, "initializeV2_2", [[], "USDC"]);
  await send(usdc, abi, "configureMinter", [a, 10n ** 12n]);

  const wallet = await deploy(walletArtifact.abi, walletArtifact.bytecode, [who.walletOwnerA.address]);
  await send(usdc, abi, "mint", [who.buyer.address, 10_000_000n]);
  await send(usdc, abi, "mint", [wallet, 10_000_000n]);
  return { usdc, wallet };
}

export async function balanceOf(usdc: Address, owner: Address): Promise<bigint> {
  return (await pub.readContract({ address: usdc, abi: usdcArtifact.abi, functionName: "balanceOf", args: [owner] })) as bigint;
}

export async function authorizationUsed(usdc: Address, from: Address, nonce: Hex): Promise<boolean> {
  return (await pub.readContract({
    address: usdc,
    abi: usdcArtifact.abi,
    functionName: "authorizationState",
    args: [from, nonce],
  })) as boolean;
}
