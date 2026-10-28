// The guard: runs every minute from the Worker's cron trigger.
//
// Each step is wrapped on its own. One failed read (an RPC timeout, a stale
// feed) skips that step this minute and never stops the others, which is the
// failure mode that kills the official perp-guard.

import { account, listMarkets, openPositions, poolState, publicClient, type Address, type Position } from "./chain";
import { settings, type Env } from "./env";
import { alertsOn, del, getJson, listWatches, putJson, watchKey } from "./state";
import { send } from "./telegram";
import { closeExisting, fmtPrice, fmtSigned, makeWatch } from "./trade";
import { closeButtons, closeText, digestText } from "./bot";

const HEALTH_ALERT_EVERY_MS = 15 * 60_000;

export async function runGuard(env: Env): Promise<void> {
  if (!(await alertsOn(env))) return;
  const s = settings(env);
  const chat = env.TELEGRAM_OWNER_ID;
  const owner = env.OWNER_ADDRESS as Address;
  const client = publicClient(env);

  let positions: Position[];
  try {
    positions = await openPositions(env, client, owner);
  } catch (err) {
    console.log(`guard: positions unreadable this minute: ${(err as Error).message}`);
    return;
  }

  // 1. Positions that closed elsewhere (in the app, by liquidation) stop being watched.
  const watches = await listWatches(env);
  const held = new Set(positions.map((p) => p.market.name));
  for (const name of Object.keys(watches)) {
    if (!held.has(name)) {
      await del(env, watchKey(name));
      await send(env, chat, `${name} is closed. Perch stopped watching it.`);
    }
  }

  // 2. Take-profit and stop-loss, from the pool's own mark.
  for (const p of positions) {
    try {
      let w = watches[p.market.name];
      if (!w || w.side !== p.side) {
        // A position opened in the app, or one that flipped side: watch it on its REAL side.
        w = makeWatch(p, s.takeProfitPct, s.stopLossPct);
        await putJson(env, watchKey(p.market.name), w);
        await send(
          env,
          chat,
          `Now watching your ${p.market.name} ${p.side}: take-profit ${fmtPrice(w.takeProfit)}, stop-loss ${fmtPrice(w.stopLoss)}.`,
        );
        continue;
      }
      const st = await poolState(client, p.market.pool);
      if (!st?.markOk) continue;
      const hitTp = p.side === "long" ? st.mark >= w.takeProfit : st.mark <= w.takeProfit;
      const hitSl = p.side === "long" ? st.mark <= w.stopLoss : st.mark >= w.stopLoss;
      if (hitTp || hitSl) {
        const out = await closeExisting(env, p, hitTp ? "take-profit hit" : "stop-loss hit");
        await send(env, chat, closeText(out, p.market.name), closeButtons(out, p.market.name, p.side));
      }
    } catch (err) {
      console.log(`guard: ${p.market.name} skipped: ${(err as Error).message}`);
    }
  }

  // 3. Account health across all positions (margin is cross).
  try {
    const markets = await listMarkets(env);
    if (markets.length > 0 && positions.length > 0) {
      const view = await account(client, markets[0]!.marginBank, owner);
      const h = view.health;
      if (h !== undefined && Number.isFinite(h)) {
        if (h < s.healthClose) {
          // Close the largest position first: it frees the most margin.
          const biggest = [...positions].sort((a, b) => b.size * b.entry - a.size * a.entry)[0]!;
          const out = await closeExisting(env, biggest, `account health ${h.toFixed(2)}×, guard closed it`);
          await send(env, chat, `Guard: health fell to ${h.toFixed(2)}×.\n${closeText(out, biggest.market.name)}`, closeButtons(out, biggest.market.name, biggest.side));
        } else if (h < s.healthAlert) {
          const last = (await getJson<number>(env, "lastHealthAlert")) ?? 0;
          if (Date.now() - last > HEALTH_ALERT_EVERY_MS) {
            await putJson(env, "lastHealthAlert", Date.now());
            await send(env, chat, `Heads up: account health is ${h.toFixed(2)}×. The guard closes positions below ${s.healthClose}×. Add margin or reduce size.`);
          }
        }
      }
    }
  } catch (err) {
    console.log(`guard: health unreadable this minute: ${(err as Error).message}`);
  }

  // 4. Funding flips on markets you hold.
  for (const p of positions) {
    try {
      const st = await poolState(client, p.market.pool);
      if (!st?.fundingKnown) continue;
      const key = `funding:${p.market.name}`;
      const before = await getJson<string>(env, key);
      if (before && before !== st.paidSide) {
        const paying = p.side !== st.paidSide;
        await send(
          env,
          chat,
          `Funding flipped on ${p.market.name}: it now pays ${st.paidSide}s (${fmtSigned(st.fundingApr * 100, 1)}% APR). ` +
            (paying ? `Your ${p.side} is now paying funding.` : `Your ${p.side} now earns it.`),
        );
      }
      await putJson(env, key, st.paidSide, 7 * 24 * 3600);
    } catch {
      // Next minute.
    }
  }
}

/** The once-a-day funding digest, at DIGEST_HOUR_UTC. */
export async function maybeDigest(env: Env, now: Date): Promise<void> {
  if (!(await alertsOn(env))) return;
  const s = settings(env);
  if (now.getUTCHours() !== s.digestHourUtc) return;
  const today = now.toISOString().slice(0, 10);
  if ((await getJson<string>(env, "lastDigest")) === today) return;
  await putJson(env, "lastDigest", today);
  try {
    await send(env, env.TELEGRAM_OWNER_ID, await digestText(env));
  } catch (err) {
    console.log(`digest failed: ${(err as Error).message}`);
  }
}
