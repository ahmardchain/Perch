// Perch: a Telegram bot that trades and guards dreamDEX perps on Somnia Tokyo testnet.
//
// Routes:
//   POST /telegram         Telegram webhook (checked against TELEGRAM_WEBHOOK_SECRET)
//   GET  /setup?key=…      one-time: registers the webhook and the command menu
//   GET  /                 health check
// Cron (every minute): the guard, alerts and the daily funding digest.

import { handleUpdate } from "./bot";
import type { Env } from "./env";
import { maybeDigest, runGuard } from "./guard";
import { setCommands, setWebhook, type Update } from "./telegram";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = (await request.json().catch(() => null)) as Update | null;
      // Answer Telegram at once and do the chain work after, so a slow RPC never
      // makes Telegram retry (and re-send) the same command.
      if (update) ctx.waitUntil(handleUpdate(env, update).catch((e) => console.log(`update failed: ${e}`)));
      return new Response("ok");
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get("key") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const hook = await setWebhook(env, `${url.origin}/telegram`);
      const cmds = await setCommands(env);
      return Response.json({ webhook: Boolean(hook), commands: Boolean(cmds) });
    }

    if (url.pathname === "/") return new Response("Perch is running.");
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await runGuard(env).catch((e) => console.log(`guard failed: ${e}`));
        await maybeDigest(env, new Date(controller.scheduledTime)).catch((e) => console.log(`digest failed: ${e}`));
      })(),
    );
  },
};
