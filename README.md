# Perch

**Your dreamDEX perps, watched from above.** Perch is a Telegram bot that trades and guards
perpetual futures on [dreamDEX](https://x.com/DreamDEXSomnia) (Somnia Tokyo testnet), so you
can open a position, protect it and close it without ever opening a browser.

Built for the dreamDEX Perps Builder Bounty, MVP track, category **bots and agents**.

## What it does

- **Trade from chat.** `/long BTC 50` opens a 50 USDso long at market, after a confirm button.
  `/close BTC` closes it.
- **Every position is protected.** Perch sets a take-profit and a stop-loss from the position's
  real entry and side, and watches them every minute from the pool's own mark price.
- **A guard for the whole account.** Margin is cross, so Perch watches account health
  (equity ÷ maintenance margin). It warns you when health gets low, and closes your largest
  position if it becomes critical.
- **Funding alerts and a daily digest.** Perch tells you when funding flips on a market you
  hold, and posts the five biggest funding carries every morning.
- **Share your results.** Every close comes with a one-tap "Share on X" button carrying the
  result and the transaction link.
- **Proof built in.** `/proof` lists every live order Perch has sent, with explorer links.

## Who it's for

Perps traders who live in Telegram and don't want to sit in front of a trading screen: the
bot trades, protects and reports, and you act from your phone.

## How it works

```
Telegram  ──webhook──▶  Cloudflare Worker  ──viem / HTTP──▶  dreamDEX contracts (Hideki, chain 50383)
                         │   cron every minute: TP/SL, health guard, funding alerts, digest
                         └── Workers KV: watched levels, settings, tx evidence
```

- **Non-custodial.** Perch trades through a **bot key you link in the dreamDEX app**
  (wallet → Link a bot → Perps). That key can place and cancel orders for your account, but it
  can never withdraw. Orders are sent with `placeOrderFor`, so the margin and fills are your
  account's; the key only pays gas.
- **Owner-only.** Only your Telegram user id can use the bot. Webhook calls are checked
  against a secret token.
- **Built not to fall over.** Every chain read is isolated: one RPC timeout or one stale
  oracle skips that step for a minute instead of crashing the guard. (While testing, we
  found the official kit's perp-guard exits on a single RPC timeout.)
- **Prices come from the pool.** Triggers use the pool's own `tryGetMarkPrice`, never the
  indexer row, which lags by tens of minutes. When a feed is stale, Perch pauses new opens but
  can still close, falling back to the index price.
- **No double closes.** Every close takes a short lock and re-reads the position first, so a
  chat close and a guard close can't race into the opposite side.

## Commands

| Command | What it does |
| --- | --- |
| `/markets` | Mark price and funding for the top markets |
| `/account` | Equity, health, open positions with uPnL and TP/SL |
| `/long BTC 50` / `/short ETH 50` | Open at market with that much position value (USDso) |
| `/close BTC` | Close a position at market |
| `/alerts on` / `/alerts off` | Turn alerts and the guard on or off |
| `/digest` | Funding digest now |
| `/check` | Bot key address, live/dry-run mode, link status |
| `/proof` | Recent live orders with transaction links |

## Run it

You need: a Telegram bot token from [@BotFather](https://t.me/BotFather), your numeric Telegram
id (ask [@userinfobot](https://t.me/userinfobot)), a dreamDEX account on Somnia Tokyo testnet with
paper USDso, and a **fresh** wallet to use as the bot key, holding a little STT for gas.

1. **Link the bot key.** In the dreamDEX app: wallet → Link a bot → tick Perps → paste the
   bot key's address.
2. **Deploy to Cloudflare.** In the Cloudflare dashboard: Workers & Pages → Create → Import a
   repository → pick this repo. Wrangler config, the KV namespace and the every-minute cron
   come from `wrangler.toml`.
3. **Add the secrets** (Worker → Settings → Variables and Secrets, type *Secret*):
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `TELEGRAM_WEBHOOK_SECRET` (any long random
   string), `OWNER_ADDRESS` (your dreamDEX account), `BOT_PRIVATE_KEY` (the linked bot key).
4. **Connect Telegram.** Open `https://<your-worker>.workers.dev/setup?key=<TELEGRAM_WEBHOOK_SECRET>`
   once. It should answer `{"webhook":true,"commands":true}`.
5. **Try it.** Send `/check`, then `/markets`. Perch starts in **dry run**: it shows what it
   would send. When `/check` says *linked*, set the variable `DRY_RUN` to `false` to trade live.

Local development: copy `.dev.vars.example` to `.dev.vars`, then `npm install` and `npm run dev`.
Tests: `npm test`.

## Proof

Live orders on Somnia Tokyo testnet (from `/proof`):

| Time (UTC) | Action | Market | Side | Size | Transaction |
| --- | --- | --- | --- | --- | --- |
| _to be added after the first live run_ | | | | | |

## Demo

_Video link to be added._

## X posts

_Links to 2–3 posts tagging @DreamDEXSomnia, to be added._

## Next

- PnL share card as an image (design ready).
- A Telegram Mini App with live positions and one-tap trading.
- Somnia Reactivity for instant alerts instead of the one-minute check.

## Licence

MIT. Contract ABIs come from `@somnia-chain/markets-sdk` (MIT); see `THIRD_PARTY_NOTICES.md`.
