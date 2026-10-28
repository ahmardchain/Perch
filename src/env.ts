export interface Env {
  PERCH_KV: KVNamespace;

  // Secrets: set with `wrangler secret put` or in the Cloudflare dashboard. Never commit them.
  TELEGRAM_BOT_TOKEN: string;
  /** Only this Telegram user id can use the bot. */
  TELEGRAM_OWNER_ID: string;
  /** Random string Telegram echoes on every webhook call, and the key for /setup. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Your dreamDEX account (the wallet you trade with in the app). */
  OWNER_ADDRESS: string;
  /** A bot key linked to OWNER_ADDRESS in the app (wallet, Link a bot, Perps). It can trade but never withdraw. */
  BOT_PRIVATE_KEY?: string;

  // Plain settings from wrangler.toml [vars].
  RPC_URL: string;
  INDEXER_URL: string;
  /** "false" sends real testnet orders; anything else only logs what it would send. */
  DRY_RUN: string;
  SLIPPAGE_BPS: string;
  TAKE_PROFIT_PCT: string;
  STOP_LOSS_PCT: string;
  /** Alert when equity / maintenance margin falls below this. */
  HEALTH_ALERT_RATIO: string;
  /** The guard closes positions when health falls below this. */
  HEALTH_CLOSE_RATIO: string;
  /** Hour (UTC) of the daily funding digest. */
  DIGEST_HOUR_UTC: string;
}

export interface Settings {
  dryRun: boolean;
  slippageBps: number;
  takeProfitPct: number;
  stopLossPct: number;
  healthAlert: number;
  healthClose: number;
  digestHourUtc: number;
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function settings(env: Env): Settings {
  return {
    dryRun: (env.DRY_RUN ?? "true").trim().toLowerCase() !== "false",
    slippageBps: num(env.SLIPPAGE_BPS, 50),
    takeProfitPct: num(env.TAKE_PROFIT_PCT, 2),
    stopLossPct: num(env.STOP_LOSS_PCT, 1),
    healthAlert: num(env.HEALTH_ALERT_RATIO, 1.5),
    healthClose: num(env.HEALTH_CLOSE_RATIO, 1.15),
    digestHourUtc: num(env.DIGEST_HOUR_UTC, 8),
  };
}
