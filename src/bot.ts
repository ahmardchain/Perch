// Chat commands. Only TELEGRAM_OWNER_ID can use the bot.

import {
  account,
  botAddress,
  findMarket,
  linkStatus,
  listMarkets,
  openPositions,
  poolState,
  publicClient,
  unrealizedPnl,
  type Address,
  type Side,
} from "./chain";
import { settings, type Env } from "./env";
import { alertsOn, listEvidence, putJson, watchKey, getJson, type Watch } from "./state";
import { answerCallback, edit, esc, send, type InlineButton, type Update } from "./telegram";
import { closeExisting, explorerTx, fmtPrice, fmtSigned, openPosition, shareUrl } from "./trade";

const HELP = [
  "<b>Perch</b> watches your dreamDEX perps from Telegram.",
  "",
  "/markets  mark price and funding",
  "/account  equity, health, open positions",
  "/long BTC 50  open a 50 USDso long",
  "/short ETH 50  open a 50 USDso short",
  "/close BTC  close a position",
  "/alerts on|off  alerts and the guard",
  "/digest  funding digest now",
  "/check  is the bot key linked?",
  "/proof  recent transaction hashes",
  "",
  "Every new position gets a take-profit and a stop-loss that Perch watches every minute. The guard also closes positions if your account health gets critical.",
].join("\n");

export async function handleUpdate(env: Env, u: Update): Promise<void> {
  const fromId = u.message?.from?.id ?? u.callback_query?.from.id;
  if (String(fromId) !== String(env.TELEGRAM_OWNER_ID)) {
    if (u.message) await send(env, u.message.chat.id, "Perch is a private bot.");
    if (u.callback_query) await answerCallback(env, u.callback_query.id, "Private bot");
    return;
  }
  if (u.callback_query) return handleCallback(env, u.callback_query);
  const msg = u.message;
  if (!msg?.text) return;

  const chat = msg.chat.id;
  const [rawCmd = "", ...args] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");
  try {
    switch (cmd) {
      case "/start":
      case "/help":
        return void (await send(env, chat, HELP));
      case "/markets":
        return void (await send(env, chat, await marketsText(env)));
      case "/account":
        return void (await send(env, chat, await accountText(env)));
      case "/long":
      case "/short":
        return void (await confirmOpen(env, chat, cmd.slice(1) as Side, args));
      case "/close":
        return void (await confirmClose(env, chat, args[0]));
      case "/alerts":
        return void (await setAlerts(env, chat, args[0]));
      case "/digest":
        return void (await send(env, chat, await digestText(env)));
      case "/check":
        return void (await send(env, chat, await checkText(env)));
      case "/proof":
        return void (await send(env, chat, await proofText(env)));
      default:
        return void (await send(env, chat, "I don't know that one. /help lists what I can do."));
    }
  } catch (err) {
    console.log(`command ${cmd} failed: ${(err as Error).message}`);
    await send(env, chat, `Something went wrong reading the chain: ${esc((err as Error).message.slice(0, 160))}. Try again in a moment.`);
  }
}

async function marketsText(env: Env): Promise<string> {
  const markets = await listMarkets(env);
  const client = publicClient(env);
  const states = await Promise.all(markets.map((m) => poolState(client, m.pool)));
  const rows = markets
    .map((m, i) => ({ m, s: states[i] }))
    .filter((r) => r.s?.markOk)
    .sort((a, b) => Math.abs(b.s!.fundingApr) - Math.abs(a.s!.fundingApr))
    .slice(0, 10);
  if (rows.length === 0) return "No market has a fresh mark price right now.";
  const lines = rows.map(
    ({ m, s }) =>
      `<b>${m.name}</b>  ${fmtPrice(s!.mark)}  funding ${fmtSigned(s!.fundingApr * 100, 1)}% APR, pays ${s!.paidSide}s`,
  );
  return ["<b>Markets</b> by funding (largest first)", "", ...lines].join("\n");
}

async function accountText(env: Env): Promise<string> {
  const owner = env.OWNER_ADDRESS as Address;
  const markets = await listMarkets(env);
  if (markets.length === 0) return "No perp markets found on the indexer.";
  const client = publicClient(env);
  const view = await account(client, markets[0]!.marginBank, owner);
  const positions = await openPositions(env, client, owner);

  const health =
    view.health === undefined ? "unknown (a feed is stale)" : view.health === Number.POSITIVE_INFINITY ? "nothing open" : `${view.health.toFixed(2)}×`;
  const lines = [
    `<b>Account</b> <code>${short(owner)}</code>`,
    `Equity ${view.equity === undefined ? "unknown" : `${view.equity.toFixed(2)} USDso`}`,
    `Free ${view.unlocked.toFixed(2)} · in use ${view.locked.toFixed(2)} USDso`,
    `Health ${health}${view.status ? ` · ${view.status}` : ""}`,
  ];
  if (positions.length === 0) {
    lines.push("", "No open positions.");
    return lines.join("\n");
  }
  lines.push("");
  for (const p of positions) {
    const st = await poolState(client, p.market.pool);
    const mark = st?.markOk ? st.mark : 0;
    const pnl = mark ? unrealizedPnl(p, mark) : undefined;
    const w = await getJson<Watch>(env, watchKey(p.market.name));
    lines.push(
      `<b>${p.market.name}</b> ${p.side} ${p.size} @ ${fmtPrice(p.entry)}` +
        `\n  mark ${mark ? fmtPrice(mark) : "stale"} · uPnL ${pnl === undefined ? "?" : `${fmtSigned(pnl)} USDso`}` +
        (w ? `\n  TP ${fmtPrice(w.takeProfit)} · SL ${fmtPrice(w.stopLoss)}` : ""),
    );
  }
  return lines.join("\n");
}

async function confirmOpen(env: Env, chat: number, side: Side, args: string[]): Promise<void> {
  const [symbol, amountRaw] = args;
  const amount = Number(amountRaw);
  if (!symbol || !(amount > 0)) {
    await send(env, chat, `Usage: /${side} BTC 50  (market, then size in USDso)`);
    return;
  }
  const market = await findMarket(env, symbol);
  if (!market) {
    await send(env, chat, `No perp market called ${esc(symbol.toUpperCase())}. Try /markets.`);
    return;
  }
  const s = settings(env);
  const buttons: InlineButton[][] = [
    [
      { text: `Confirm ${side} ${amount} USDso`, callback_data: `open:${side}:${market.base}:${amount}` },
      { text: "Cancel", callback_data: "cancel" },
    ],
  ];
  await send(
    env,
    chat,
    `${side === "long" ? "Long" : "Short"} <b>${market.name}</b> with ${amount} USDso of position value?\n` +
      `Take-profit ${s.takeProfitPct}% · stop-loss ${s.stopLossPct}%, watched by Perch.` +
      (s.dryRun ? "\n\n<i>Dry run: nothing will be sent.</i>" : ""),
    buttons,
  );
}

async function confirmClose(env: Env, chat: number, symbol?: string): Promise<void> {
  if (!symbol) {
    await send(env, chat, "Usage: /close BTC");
    return;
  }
  const market = await findMarket(env, symbol);
  if (!market) {
    await send(env, chat, `No perp market called ${esc(symbol.toUpperCase())}.`);
    return;
  }
  await send(env, chat, `Close your <b>${market.name}</b> position at market?`, [
    [
      { text: "Close it", callback_data: `close:${market.base}` },
      { text: "Cancel", callback_data: "cancel" },
    ],
  ]);
}

async function handleCallback(env: Env, q: NonNullable<Update["callback_query"]>): Promise<void> {
  const chat = q.message?.chat.id;
  const msgId = q.message?.message_id;
  if (!chat || !msgId || !q.data) return void (await answerCallback(env, q.id));
  const [kind, a, b, c] = q.data.split(":");

  if (kind === "cancel") {
    await answerCallback(env, q.id, "Cancelled");
    await edit(env, chat, msgId, "Cancelled.");
    return;
  }

  await answerCallback(env, q.id, "Working on it…");
  try {
    if (kind === "open" && a && b && c) {
      await edit(env, chat, msgId, `Sending ${a} on ${b}-PERP…`);
      const out = await openPosition(env, b, a as Side, Number(c));
      const extra = out.watch ? `\nTake-profit ${fmtPrice(out.watch.takeProfit)} · stop-loss ${fmtPrice(out.watch.stopLoss)}` : "";
      const link = out.hash ? `\n<a href="${explorerTx(out.hash)}">View transaction</a>` : "";
      await edit(env, chat, msgId, `${esc(out.message)}${extra}${link}`);
      return;
    }
    if (kind === "close" && a) {
      const market = await findMarket(env, a);
      if (!market) return void (await edit(env, chat, msgId, "That market is gone."));
      const client = publicClient(env);
      const positions = await openPositions(env, client, env.OWNER_ADDRESS as Address);
      const p = positions.find((x) => x.market.pool === market.pool);
      if (!p) return void (await edit(env, chat, msgId, `No open position on ${market.name}.`));
      await edit(env, chat, msgId, `Closing ${market.name}…`);
      const out = await closeExisting(env, p, "closed from chat");
      await edit(env, chat, msgId, closeText(out, p.market.name), closeButtons(out, p.market.name, p.side));
      return;
    }
  } catch (err) {
    await edit(env, chat, msgId, `Failed: ${esc((err as Error).message.slice(0, 200))}`);
  }
}

export function closeText(out: Awaited<ReturnType<typeof closeExisting>>, market: string): string {
  const pnl =
    out.ok && out.pnlPct !== undefined
      ? `\nResult ${fmtSigned(out.pnlPct)}% (${fmtSigned(out.pnlUsdso ?? 0)} USDso, estimated at ${fmtPrice(out.exitRef ?? 0)})`
      : "";
  const link = out.hash ? `\n<a href="${explorerTx(out.hash)}">View transaction</a>` : "";
  return `${esc(out.message)}${pnl}${link}`;
}

export function closeButtons(out: Awaited<ReturnType<typeof closeExisting>>, market: string, side: Side): InlineButton[][] | undefined {
  if (!out.ok || out.pnlPct === undefined) return undefined;
  return [[{ text: "Share on X", url: shareUrl(market, side, out.pnlPct, out.hash) }]];
}

async function setAlerts(env: Env, chat: number, arg?: string): Promise<void> {
  if (arg !== "on" && arg !== "off") {
    const on = await alertsOn(env);
    await send(env, chat, `Alerts and the guard are <b>${on ? "on" : "off"}</b>. Use /alerts on or /alerts off.`);
    return;
  }
  await putJson(env, "alerts", arg === "on");
  await send(
    env,
    chat,
    arg === "on"
      ? "Alerts and the guard are on. Perch checks your positions every minute."
      : "Alerts and the guard are off. Your take-profits and stop-losses are NOT watched until you turn them back on.",
  );
}

export async function digestText(env: Env): Promise<string> {
  const markets = await listMarkets(env);
  const client = publicClient(env);
  const states = await Promise.all(markets.map((m) => poolState(client, m.pool)));
  const ranked = markets
    .map((m, i) => ({ m, s: states[i] }))
    .filter((r) => r.s?.markOk && r.s.fundingKnown)
    .sort((a, b) => Math.abs(b.s!.fundingApr) - Math.abs(a.s!.fundingApr))
    .slice(0, 5);
  if (ranked.length === 0) return "Funding digest: no readable funding right now.";
  const lines = ranked.map(
    ({ m, s }) => `<b>${m.name}</b> ${fmtSigned(s!.fundingApr * 100, 1)}% APR, ${s!.paidSide}s get paid`,
  );
  return ["<b>Funding digest</b>: the five biggest carries on dreamDEX right now", "", ...lines, "", "Open the paid side with /long or /short."].join("\n");
}

async function checkText(env: Env): Promise<string> {
  const s = settings(env);
  const bot = botAddress(env);
  const lines = [
    `Account <code>${short(env.OWNER_ADDRESS)}</code>`,
    `Bot key ${bot ? `<code>${bot}</code>` : "not set (read-only)"}`,
    `Mode ${s.dryRun ? "dry run (nothing is sent)" : "LIVE testnet orders"}`,
  ];
  if (bot) {
    const markets = await listMarkets(env);
    const client = publicClient(env);
    const sample = markets.filter((m) => ["BTC", "ETH"].includes(m.base));
    for (const m of sample.length ? sample : markets.slice(0, 2)) {
      try {
        const st = await linkStatus(client, m.pool, env.OWNER_ADDRESS as Address, bot);
        lines.push(`${m.name}: ${st.place && st.cancel ? "linked" : "NOT linked"}`);
      } catch {
        lines.push(`${m.name}: could not check`);
      }
    }
    lines.push("", "Not linked? In the dreamDEX app: wallet, Link a bot, tick Perps, paste the bot key address above. Give the bot key a little STT for gas.");
  }
  return lines.join("\n");
}

async function proofText(env: Env): Promise<string> {
  const rows = await listEvidence(env);
  if (rows.length === 0) return "No live orders yet.";
  return [
    "<b>Recent live orders</b>",
    "",
    ...rows.slice(0, 15).map(
      (r) => `${r.at.slice(0, 16).replace("T", " ")} ${r.action} ${r.market} ${r.side} ${r.size}${r.reason ? ` (${esc(r.reason)})` : ""}\n<a href="${explorerTx(r.hash)}">${r.hash.slice(0, 18)}…</a>`,
    ),
  ].join("\n");
}

function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
