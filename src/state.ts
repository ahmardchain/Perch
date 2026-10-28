// Small pieces of state Perch keeps between messages and cron runs, in Workers KV.

import type { Side } from "./chain";
import type { Env } from "./env";

/** The take-profit / stop-loss Perch watches for one market. */
export interface Watch {
  side: Side;
  entry: number;
  takeProfit: number;
  stopLoss: number;
  openedAt: number;
}

export interface EvidenceRow {
  at: string;
  action: "open" | "close";
  market: string;
  side: Side;
  size: string;
  hash: string;
  reason?: string;
}

const kv = (env: Env) => env.PERCH_KV;

export async function getJson<T>(env: Env, key: string): Promise<T | undefined> {
  try {
    return ((await kv(env).get(key, "json")) as T | null) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function putJson(env: Env, key: string, value: unknown, ttlSec?: number): Promise<void> {
  try {
    await kv(env).put(key, JSON.stringify(value), ttlSec ? { expirationTtl: ttlSec } : undefined);
  } catch (err) {
    console.log(`kv put ${key} failed: ${(err as Error).message}`);
  }
}

export async function del(env: Env, key: string): Promise<void> {
  try {
    await kv(env).delete(key);
  } catch {
    // Nothing to do: a stale key is re-checked next run.
  }
}

export const watchKey = (market: string) => `watch:${market}`;

export async function listWatches(env: Env): Promise<Record<string, Watch>> {
  const out: Record<string, Watch> = {};
  try {
    const list = await kv(env).list({ prefix: "watch:" });
    for (const k of list.keys) {
      const w = await getJson<Watch>(env, k.name);
      if (w) out[k.name.slice("watch:".length)] = w;
    }
  } catch {
    // An empty map just means nothing is watched this run.
  }
  return out;
}

export async function alertsOn(env: Env): Promise<boolean> {
  return (await getJson<boolean>(env, "alerts")) ?? true;
}

export async function addEvidence(env: Env, row: EvidenceRow): Promise<void> {
  const rows = (await getJson<EvidenceRow[]>(env, "evidence")) ?? [];
  rows.unshift(row);
  await putJson(env, "evidence", rows.slice(0, 50));
}

export async function listEvidence(env: Env): Promise<EvidenceRow[]> {
  return (await getJson<EvidenceRow[]>(env, "evidence")) ?? [];
}
