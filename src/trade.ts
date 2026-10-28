// Opening and closing positions, shared by the chat commands and the guard.

import {
  findMarket,
  placeMarketOrder,
  poolState,
  position,
  publicClient,
  sizeForNotional,
  takerPrice,
  toNum,
  type Address,
  type Market,
  type Position,
  type Side,
} from "./chain";
import { settings, type Env } from "./env";
import { addEvidence, del, getJson, putJson, watchKey, type Watch } from "./state";

export const explorerTx = (hash: string) => `https://explorer.testnet.somnia.network/tokyo/tx/${hash}`;

export interface OpenOutcome {
  ok: boolean;
  message: string;
  hash?: string;
  watch?: Watch;
}

export async function openPosition(env: Env, symbol: string, side: Side, notional: number): Promise<OpenOutcome> {
  const s = settings(env);
  const market = await findMarket(env, symbol);
  if (!market) return { ok: false, message: `No perp market called ${symbol.toUpperCase()}. Try /markets.` };

  const client = publicClient(env);
  const owner = env.OWNER_ADDRESS as Address;
  const existing = await position(client, market, owner).catch(() => undefined);
  if (existing && existing.side !== side) {
    return {
      ok: false,
      message: `You already hold a ${existing.side} on ${market.name}. Close it first with /close ${market.base}.`,
    };
  }

  const state = await poolState(client, market.pool);
  if (!state?.markOk) return { ok: false, message: `${market.name} has no fresh mark price right now, so new positions are paused. Try again shortly.` };

  const quantity = sizeForNotional(notional, state.markRaw, market);
  if (quantity === 0n) {
    const min = toNum(market.minQuantity, market.baseDecimals);
    return { ok: false, message: `${notional} USDso is below ${market.name}'s minimum size (${min} ${market.base}, about ${(min * state.mark).toFixed(2)} USDso).` };
  }
  const price = takerPrice(state.markRaw, side, s.slippageBps, market);
  const size = toNum(quantity, market.baseDecimals);

  if (s.dryRun) {
    return {
      ok: true,
      message: `[dry run] Would ${side} ${size} ${market.base} (~${notional} USDso) on ${market.name} at up to ${toNum(price, 18)}. Set DRY_RUN to "false" to trade.`,
    };
  }

  const res = await placeMarketOrder(env, { market, side, quantity, price, dryRun: false });
  if (!res.sent || res.error) return { ok: false, message: `Order not filled: ${res.error ?? "unknown reason"}.` };

  // Read the position back: it is the account's real size and average entry, whatever partially filled.
  const after = await position(client, market, owner).catch(() => undefined);
  if (!after) return { ok: false, hash: res.hash, message: `Order sent but nothing filled (tx ${res.hash}). The book may have moved.` };

  const watch = makeWatch(after, s.takeProfitPct, s.stopLossPct);
  await putJson(env, watchKey(market.name), watch);
  await addEvidence(env, {
    at: new Date().toISOString(),
    action: "open",
    market: market.name,
    side,
    size: String(after.size),
    hash: res.hash!,
  });
  return { ok: true, hash: res.hash, watch, message: `Opened ${side} ${after.size} ${market.base} on ${market.name} at ${fmtPrice(after.entry)}.` };
}

export function makeWatch(p: Position, tpPct: number, slPct: number): Watch {
  // Levels follow the position's ACTUAL side, never a configured one.
  const up = (pct: number) => p.entry * (1 + pct / 100);
  const down = (pct: number) => p.entry * (1 - pct / 100);
  return {
    side: p.side,
    entry: p.entry,
    takeProfit: p.side === "long" ? up(tpPct) : down(tpPct),
    stopLoss: p.side === "long" ? down(slPct) : up(slPct),
    openedAt: Date.now(),
  };
}

export interface CloseOutcome {
  ok: boolean;
  message: string;
  hash?: string;
  /** Price return of the closed position, in percent. */
  pnlPct?: number;
  pnlUsdso?: number;
  exitRef?: number;
}

/**
 * Close a position at market. Reducing orders are accepted even while a feed
 * is stale, so when the mark is unavailable this falls back to the index price
 * with double the slippage rather than refusing to exit.
 */
export async function closeExisting(env: Env, stale: Position, reason: string): Promise<CloseOutcome> {
  const s = settings(env);
  const client = publicClient(env);
  const market: Market = stale.market;

  // Two closes racing (the guard and a tap in chat) would sell the position twice
  // and open the opposite side. A short lock plus a fresh read prevents that.
  const lockKey = `closing:${market.name}`;
  if (!s.dryRun) {
    if (await getJson<number>(env, lockKey)) return { ok: false, message: `A close on ${market.name} is already in progress.` };
    await putJson(env, lockKey, Date.now(), 60);
  }
  try {
    const fresh = await position(client, market, env.OWNER_ADDRESS as Address);
    if (!fresh) {
      await del(env, watchKey(market.name));
      return { ok: false, message: `${market.name} is already closed.` };
    }
    return await closeNow(env, fresh, reason);
  } finally {
    if (!s.dryRun) await del(env, lockKey);
  }
}

async function closeNow(env: Env, p: Position, reason: string): Promise<CloseOutcome> {
  const s = settings(env);
  const client = publicClient(env);
  const market: Market = p.market;
  const state = await poolState(client, market.pool);
  const refRaw = state?.markOk ? state.markRaw : state && state.index > 0 ? BigInt(Math.round(state.index * 1e6)) * 10n ** 12n : 0n;
  if (refRaw === 0n) return { ok: false, message: `Could not read any price for ${market.name}. Retrying next minute.` };

  const closingSide: Side = p.side === "long" ? "short" : "long";
  const slip = state?.markOk ? s.slippageBps : s.slippageBps * 2;
  const price = takerPrice(refRaw, closingSide, slip, market);
  const exitRef = toNum(refRaw, 18);
  const diff = p.side === "long" ? exitRef - p.entry : p.entry - exitRef;
  const pnlPct = p.entry > 0 ? (diff / p.entry) * 100 : 0;
  const pnlUsdso = diff * p.size;

  if (s.dryRun) {
    return { ok: true, pnlPct, pnlUsdso, exitRef, message: `[dry run] Would close ${p.side} ${p.size} ${market.base} on ${market.name} (${reason}).` };
  }

  const res = await placeMarketOrder(env, { market, side: closingSide, quantity: p.sizeRaw, price, dryRun: false });
  if (!res.sent || res.error) return { ok: false, message: `Close not filled: ${res.error ?? "unknown reason"}. Retrying next minute.` };

  const left = await position(client, market, env.OWNER_ADDRESS as Address).catch(() => undefined);
  if (!left) await del(env, watchKey(market.name));
  await addEvidence(env, {
    at: new Date().toISOString(),
    action: "close",
    market: market.name,
    side: p.side,
    size: String(p.size),
    hash: res.hash!,
    reason,
  });
  return {
    ok: true,
    hash: res.hash,
    pnlPct,
    pnlUsdso,
    exitRef,
    message: left
      ? `Partly closed ${market.name}: ${left.size} ${market.base} still open. Retrying the rest next minute.`
      : `Closed ${p.side} ${p.size} ${market.base} on ${market.name} (${reason}).`,
  };
}

export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "-";
  const digits = n >= 1000 ? 1 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtSigned(n: number, digits = 2): string {
  const s = Math.abs(n).toFixed(digits);
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

/** A pre-filled X post for a closed trade. */
export function shareUrl(market: string, side: Side, pnlPct: number, hash?: string): string {
  const text =
    `Closed a ${market} ${side} at ${fmtSigned(pnlPct)}% on @DreamDEXSomnia, straight from Telegram with Perch.` +
    (hash ? `\n\nTx: ${explorerTx(hash)}` : "");
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
