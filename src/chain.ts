// Everything Perch reads from or sends to dreamDEX on Somnia Tokyo testnet (Hideki).
//
// Two lessons from testing the official bot kit are built in here:
//   1. One slow or failed RPC read must never take the bot down. Every read is
//      wrapped, and callers get `undefined` / `ok: false` instead of a throw.
//   2. The mark the POOL acts on (tryGetMarkPrice) is the price that matters.
//      The indexer's market row lags by tens of minutes, so it is only used to
//      discover markets, never to price anything.

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CANCEL_ORDER_FOR_SELECTOR,
  MARGIN_STATUS,
  ORDER_TYPE,
  PLACE_ORDER_FOR_SELECTOR,
  marginBankReadAbi,
  operatorAbi,
  perpPoolReadAbi,
} from "./abi";
import type { Env } from "./env";

export type Address = `0x${string}`;
export type Side = "long" | "short";

const E18 = 10n ** 18n;
const ONE_YEAR_SEC = 31_536_000;
/** The gas limit the SDK sends a perp order with. Somnia bills gas used, not the limit. */
const ORDER_GAS = 10_000_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export function hideki(rpcUrl: string) {
  return defineChain({
    id: 50383,
    name: "Somnia Tokyo testnet (Hideki)",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11", blockCreated: 1 } },
    testnet: true,
  });
}

export function publicClient(env: Env): PublicClient {
  return createPublicClient({
    chain: hideki(env.RPC_URL),
    transport: http(env.RPC_URL, { timeout: 10_000, retryCount: 2 }),
  }) as PublicClient;
}

// ---------------------------------------------------------------- markets

export interface Market {
  /** App name, e.g. "BTC-PERP". */
  name: string;
  base: string;
  pool: Address;
  marginBank: Address;
  baseDecimals: number;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  initialMarginBps: number;
}

const MARKETS_QUERY = `query PerchPerpMarkets($limit: Int) {
  Market(where: { marketType: { _eq: "PERP" } }, order_by: { createdAtTimestamp: desc }, limit: $limit) {
    poolAddress marginBank baseSymbol baseDecimals tickSize lotSize minQuantity initialMarginBps
  }
}`;

interface MarketRow {
  poolAddress: string;
  marginBank: string | null;
  baseSymbol: string;
  baseDecimals: number;
  tickSize: string;
  lotSize: string;
  minQuantity: string;
  initialMarginBps: number | string | null;
}

/** All perp markets, from the indexer, cached for 10 minutes. */
export async function listMarkets(env: Env): Promise<Market[]> {
  const cached = await env.PERCH_KV.get("markets", "json").catch(() => null);
  if (Array.isArray(cached) && cached.length > 0) return (cached as MarketJson[]).map(fromJson);

  const res = await fetch(env.INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: MARKETS_QUERY, variables: { limit: 100 } }),
  });
  if (!res.ok) throw new Error(`indexer answered ${res.status}`);
  const body = (await res.json()) as { data?: { Market?: MarketRow[] }; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`indexer: ${body.errors[0]!.message}`);
  const rows = body.data?.Market ?? [];
  const markets: Market[] = rows
    .filter((r) => r.poolAddress && r.marginBank)
    .map((r) => ({
      name: `${r.baseSymbol.toUpperCase()}-PERP`,
      base: r.baseSymbol.toUpperCase(),
      pool: r.poolAddress.toLowerCase() as Address,
      marginBank: (r.marginBank as string).toLowerCase() as Address,
      baseDecimals: Number(r.baseDecimals),
      tickSize: BigInt(r.tickSize),
      lotSize: BigInt(r.lotSize),
      minQuantity: BigInt(r.minQuantity),
      initialMarginBps: Number(r.initialMarginBps ?? 0),
    }));
  await env.PERCH_KV.put("markets", JSON.stringify(markets.map(toJson)), { expirationTtl: 600 }).catch(() => {});
  return markets;
}

type MarketJson = Omit<Market, "tickSize" | "lotSize" | "minQuantity"> & {
  tickSize: string;
  lotSize: string;
  minQuantity: string;
};
const toJson = (m: Market): MarketJson => ({
  ...m,
  tickSize: m.tickSize.toString(),
  lotSize: m.lotSize.toString(),
  minQuantity: m.minQuantity.toString(),
});
const fromJson = (m: MarketJson): Market => ({
  ...m,
  tickSize: BigInt(m.tickSize),
  lotSize: BigInt(m.lotSize),
  minQuantity: BigInt(m.minQuantity),
});

/** "btc", "BTC-PERP" and "BTC/USDso:USDso" all find BTC-PERP. */
export async function findMarket(env: Env, input: string): Promise<Market | undefined> {
  const base = input.trim().toUpperCase().split("/")[0]!.replace(/-PERP$/, "");
  return (await listMarkets(env)).find((m) => m.base === base);
}

// ---------------------------------------------------------------- pool state

export interface PoolState {
  /** False while the oracle is stale: opens are rejected, reducing orders still work. */
  markOk: boolean;
  /** Mark price as a human number, 0 when unknown. */
  mark: number;
  markRaw: bigint;
  index: number;
  /** Annualised funding as a fraction (0.12 = 12% APR). Positive means longs pay shorts. */
  fundingApr: number;
  fundingKnown: boolean;
  /** The side funding currently pays. */
  paidSide: Side;
}

export async function poolState(client: PublicClient, pool: Address): Promise<PoolState | undefined> {
  try {
    const p = { address: pool, abi: perpPoolReadAbi } as const;
    const [mark, index, rate, params] = await client.multicall({
      allowFailure: true,
      contracts: [
        { ...p, functionName: "tryGetMarkPrice" },
        { ...p, functionName: "getIndexPrice" },
        { ...p, functionName: "getCurrentFundingRate" },
        { ...p, functionName: "getFundingParameters" },
      ],
    });
    const [ok, markRaw] = mark.status === "success" ? mark.result : [false, 0n];
    const indexRaw = index.status === "success" ? index.result[0] : 0n;
    const rateRaw = rate.status === "success" ? rate.result : 0n;
    const windowSec = params.status === "success" ? Number(params.result.fundingCalculationWindowSec) : 0;
    const fundingKnown = rate.status === "success" && windowSec > 0;
    const fundingApr = fundingKnown ? (Number(rateRaw) / 1e18) * (ONE_YEAR_SEC / windowSec) : 0;
    const usable = ok && markRaw > 0n;
    return {
      markOk: usable,
      mark: usable ? toNum(markRaw, 18) : 0,
      markRaw: usable ? markRaw : 0n,
      index: toNum(indexRaw, 18),
      fundingApr,
      fundingKnown,
      paidSide: rateRaw > 0n ? "short" : "long",
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- account and positions

export interface Position {
  market: Market;
  side: Side;
  /** Absolute size in raw base units. */
  sizeRaw: bigint;
  size: number;
  entry: number;
}

export async function position(client: PublicClient, market: Market, owner: Address): Promise<Position | undefined> {
  const p = await client.readContract({
    address: market.marginBank,
    abi: marginBankReadAbi,
    functionName: "getPosition",
    args: [owner, market.pool],
  });
  if (p.size === 0n) return undefined;
  const sizeRaw = p.size < 0n ? -p.size : p.size;
  return {
    market,
    side: p.size > 0n ? "long" : "short",
    sizeRaw,
    size: toNum(sizeRaw, market.baseDecimals),
    entry: toNum(p.avgEntryPrice, 18),
  };
}

export interface AccountView {
  /** Collateral not backing anything, USDso. */
  unlocked: number;
  locked: number;
  /** Undefined when equity could not be read (e.g. a stale feed on a held market). */
  equity?: number;
  /** equity / maintenance requirement. Infinity with nothing open; undefined when unreadable. */
  health?: number;
  status?: string;
  activePools: Address[];
}

/**
 * The account's cross-margin state. `getAccountHealth` reverts when ANY held
 * market's feed is stale, so it is read on its own and allowed to fail: the
 * rest of the view still comes back, and the guard keeps working.
 */
export async function account(client: PublicClient, marginBank: Address, owner: Address): Promise<AccountView> {
  const bank = { address: marginBank, abi: marginBankReadAbi } as const;
  const state = await client.readContract({ ...bank, functionName: "getAccountState", args: [owner] });
  const view: AccountView = {
    unlocked: toNum(state.unlockedCollateralBalance, 18),
    locked: toNum(state.lockedCollateral, 18),
    activePools: [...state.activePerpPools].map((a) => a.toLowerCase() as Address),
  };
  try {
    const [equity, , mmReq] = await client.readContract({ ...bank, functionName: "getAccountHealth", args: [owner] });
    view.equity = toNum(equity, 18);
    view.health = mmReq === 0n ? Number.POSITIVE_INFINITY : Number(equity) / Number(mmReq);
  } catch {
    try {
      const [ok, equity] = await client.readContract({ ...bank, functionName: "tryGetAccountEquity", args: [owner] });
      if (ok) view.equity = toNum(equity, 18);
    } catch {
      // Equity stays unknown; callers say so rather than guessing.
    }
  }
  try {
    const s = await client.readContract({ ...bank, functionName: "getMarginStatus", args: [owner] });
    view.status = MARGIN_STATUS[Number(s)] ?? "Healthy";
  } catch {
    // Leave status unknown rather than claiming "Healthy".
  }
  return view;
}

/** Every open position across the markets the MarginBank says this account is active in. */
export async function openPositions(env: Env, client: PublicClient, owner: Address): Promise<Position[]> {
  const markets = await listMarkets(env);
  if (markets.length === 0) return [];
  const view = await account(client, markets[0]!.marginBank, owner);
  const active = new Set(view.activePools);
  const held = markets.filter((m) => active.has(m.pool));
  const out: Position[] = [];
  for (const m of held) {
    try {
      const p = await position(client, m, owner);
      if (p) out.push(p);
    } catch {
      // One failed read skips one market this round; it never stops the others.
    }
  }
  return out;
}

// ---------------------------------------------------------------- sizing

/** Align a price to the tick grid, rounding toward the side that still fills. */
export function alignPrice(raw: bigint, tick: bigint, up: boolean): bigint {
  if (tick <= 0n) return raw;
  const down = (raw / tick) * tick;
  return up && down < raw ? down + tick : down;
}

/** Base quantity for a USDso notional at a mark, on the lot grid. 0n when below the market minimum. */
export function sizeForNotional(notionalUsdso: number, markRaw: bigint, market: Market): bigint {
  if (markRaw <= 0n || !(notionalUsdso > 0)) return 0n;
  const notionalRaw = BigInt(Math.round(notionalUsdso * 1e6)) * 10n ** 12n; // 18-decimal USDso
  const qty = (notionalRaw * 10n ** BigInt(market.baseDecimals)) / markRaw;
  return alignQuantity(qty, market);
}

export function alignQuantity(qty: bigint, market: Market): bigint {
  const aligned = market.lotSize > 0n ? (qty / market.lotSize) * market.lotSize : qty;
  return aligned < market.minQuantity ? 0n : aligned;
}

/** An immediate-or-cancel limit that crosses the mark by `slippageBps`. Longs pay up, shorts sell down. */
export function takerPrice(markRaw: bigint, side: Side, slippageBps: number, market: Market): bigint {
  const slip = BigInt(Math.max(0, Math.round(slippageBps)));
  const raw = side === "long" ? (markRaw * (10_000n + slip)) / 10_000n : (markRaw * (10_000n - slip)) / 10_000n;
  return alignPrice(raw, market.tickSize, side === "short");
}

// ---------------------------------------------------------------- writes through the linked key

export interface LinkStatus {
  place: boolean;
  cancel: boolean;
}

export async function linkStatus(client: PublicClient, pool: Address, owner: Address, operator: Address): Promise<LinkStatus> {
  const ask = (selector: Hex) =>
    client.readContract({
      address: pool,
      abi: operatorAbi,
      functionName: "isOperatorAuthorized",
      args: [owner, operator, selector],
    }) as Promise<boolean>;
  const [place, cancel] = await Promise.all([ask(PLACE_ORDER_FOR_SELECTOR), ask(CANCEL_ORDER_FOR_SELECTOR)]);
  return { place, cancel };
}

export function botAddress(env: Env): Address | undefined {
  if (!env.BOT_PRIVATE_KEY) return undefined;
  return privateKeyToAccount(env.BOT_PRIVATE_KEY as Hex).address;
}

export interface OrderResult {
  sent: boolean;
  hash?: Hex;
  /** Set when the order did not go through, in words a trader can act on. */
  error?: string;
  /** True when an IOC crossed nothing because the book moved. Not a fault. */
  noFill?: boolean;
}

/**
 * Place an immediate-or-cancel order FOR the owner's account through the linked
 * bot key. The order, its margin and its fills are the account's; the key only
 * pays gas. Simulated first, so a rejection arrives as its named contract error
 * and nothing is mined.
 */
export async function placeMarketOrder(
  env: Env,
  args: { market: Market; side: Side; quantity: bigint; price: bigint; dryRun: boolean },
): Promise<OrderResult> {
  if (args.dryRun) return { sent: false };
  if (!env.BOT_PRIVATE_KEY) return { sent: false, error: "BOT_PRIVATE_KEY is not set, so Perch can only read." };

  const chain = hideki(env.RPC_URL);
  const account = privateKeyToAccount(env.BOT_PRIVATE_KEY as Hex);
  const transport = http(env.RPC_URL, { timeout: 15_000, retryCount: 1 });
  const pc = createPublicClient({ chain, transport });
  const wc = createWalletClient({ account, chain, transport });
  const expireNs = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;

  try {
    const { request } = await pc.simulateContract({
      address: args.market.pool,
      abi: operatorAbi,
      functionName: "placeOrderFor",
      args: [
        env.OWNER_ADDRESS as Address,
        args.side === "long",
        0n,
        args.price,
        args.quantity,
        expireNs,
        ORDER_TYPE.MARKET,
        0,
        ZERO_ADDRESS,
        0n,
      ],
      account,
      gas: ORDER_GAS,
    });
    const hash = await wc.writeContract(request);
    const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 20_000 });
    if (receipt.status !== "success") return { sent: true, hash, error: "the order reverted on-chain" };
    return { sent: true, hash };
  } catch (err) {
    const name = revertName(err);
    if (name === "ImmediateOrCancelNoFill") return { sent: false, noFill: true, error: "nothing crossed, the book moved" };
    return { sent: false, error: explain(name, err) };
  }
}

function revertName(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? undefined;
  }
  return undefined;
}

function explain(name: string | undefined, err: unknown): string {
  switch (name) {
    case "OnlyApprovedContracts":
      return "this bot key is not linked to your account on this market. In the dreamDEX app: wallet, Link a bot, tick Perps, paste the bot address.";
    case "InvalidPrice":
      return "the price is off the tick grid";
    case "InvalidQuantity":
      return "the size is off the lot grid or below the market minimum";
    default: {
      if (name) return name;
      const msg = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
      if (/insufficient funds/i.test(msg)) return "the bot key has no STT for gas. Send it a little STT.";
      return msg.slice(0, 200);
    }
  }
}

// ---------------------------------------------------------------- helpers

export function toNum(raw: bigint, decimals: number): number {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = Number(abs / scale);
  const frac = Number(abs % scale) / Number(scale);
  return (neg ? -1 : 1) * (whole + frac);
}

export function unrealizedPnl(p: Position, mark: number): number {
  const diff = p.side === "long" ? mark - p.entry : p.entry - mark;
  return diff * p.size;
}

export { E18 };
