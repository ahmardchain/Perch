import { describe, expect, it } from "vitest";
import { alignPrice, alignQuantity, sizeForNotional, takerPrice, toNum, type Market } from "../src/chain";
import { makeWatch } from "../src/trade";

const E18 = 10n ** 18n;
const btc: Market = {
  name: "BTC-PERP",
  base: "BTC",
  pool: "0x0000000000000000000000000000000000000001",
  marginBank: "0x0000000000000000000000000000000000000002",
  baseDecimals: 8,
  tickSize: E18 / 10n, // 0.1
  lotSize: 10_000n, // 0.0001 BTC
  minQuantity: 10_000n,
  initialMarginBps: 500,
};

describe("sizing", () => {
  it("turns a USDso notional into base units on the lot grid", () => {
    const q = sizeForNotional(50, 80_000n * E18, btc); // 50 / 80,000 = 0.000625 BTC
    expect(q).toBe(60_000n); // aligned down to 0.0006
  });

  it("returns 0 below the market minimum", () => {
    expect(sizeForNotional(5, 80_000n * E18, btc)).toBe(0n);
    expect(alignQuantity(9_999n, btc)).toBe(0n);
  });

  it("crosses the mark by the slippage and stays on the tick grid", () => {
    const mark = 80_000n * E18;
    const long = takerPrice(mark, "long", 50, btc);
    const short = takerPrice(mark, "short", 50, btc);
    expect(long % btc.tickSize).toBe(0n);
    expect(short % btc.tickSize).toBe(0n);
    expect(toNum(long, 18)).toBeCloseTo(80_400, 6);
    expect(toNum(short, 18)).toBeCloseTo(79_600, 6);
  });

  it("aligns prices up or down", () => {
    expect(alignPrice(105n, 10n, false)).toBe(100n);
    expect(alignPrice(105n, 10n, true)).toBe(110n);
    expect(alignPrice(100n, 10n, true)).toBe(100n);
  });
});

describe("watch levels follow the position's real side", () => {
  const base = { market: btc, sizeRaw: 60_000n, size: 0.0006, entry: 100 };
  it("long: take-profit above, stop-loss below", () => {
    const w = makeWatch({ ...base, side: "long" }, 2, 1);
    expect(w.takeProfit).toBeCloseTo(102);
    expect(w.stopLoss).toBeCloseTo(99);
  });
  it("short: take-profit below, stop-loss above", () => {
    const w = makeWatch({ ...base, side: "short" }, 2, 1);
    expect(w.takeProfit).toBeCloseTo(98);
    expect(w.stopLoss).toBeCloseTo(101);
  });
});
