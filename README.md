# Price Watch Bot

A lightweight Node.js bot that checks live market prices and alerts when your rule is hit. It includes both a CLI mode and a small web dashboard.

## Features

- Tracks stocks and crypto symbols
- Supports threshold rules (`above` / `below`)
- Optional automatic change alerts between checks (`changeAlerts`)
- Cooldown per rule to avoid alert spam
- Optional one-shot mode for a single check
- Optional Telegram bot notifications (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`)
- No API key required

## Data Providers

- `stock` market: Stooq
- `crypto` market: CoinGecko

## Requirements

- Node.js 18+

## Setup

```bash
cd "C:\\Users\\likhi\\OneDrive\\Documents\\New project\\price-watch-bot"
copy config.example.json config.json
copy .env.example .env
```

Edit `config.json` and set your symbols and targets.

## Run

Continuous monitoring:

```bash
npm start
```

Run once and exit:

```bash
node index.js --once
```

Use a custom config path:

```bash
node index.js --config ./my-rules.json
```

Run the web dashboard:

```bash
npm run dashboard
```

Then open:

```text
http://127.0.0.1:3030
```

You can trigger an immediate check from the "Check Now" button.

## Config Format

```json
{
  "checkIntervalSeconds": 60,
  "cooldownSeconds": 300,
  "changeAlerts": {
    "enabled": true,
    "mode": "any",
    "minPercent": 0,
    "cooldownSeconds": 60
  },
  "rules": [
    {
      "market": "crypto",
      "symbol": "bitcoin",
      "label": "BTC",
      "condition": "below",
      "target": 90000
    },
    {
      "market": "stock",
      "symbol": "AAPL",
      "condition": "above",
      "target": 250
    }
  ]
}
```

- `market` must be `stock` or `crypto`.
- For `stock`, `symbol` can be `AAPL` (the bot auto-converts to `AAPL.US` for lookup).
- For `crypto`, use CoinGecko coin IDs (`bitcoin`, `ethereum`, `solana`, etc.).
- `label` is optional and only affects alert display text.
- `changeAlerts.enabled`: enable/disable automatic change alerts.
- `changeAlerts.mode`: `any`, `up`, or `down`.
- `changeAlerts.minPercent`: minimum move needed since previous check (set `0` for any change).
- `changeAlerts.cooldownSeconds`: cooldown for change alerts per symbol.

## Telegram Alerts (Optional)

PowerShell example:

```powershell
$env:TELEGRAM_BOT_TOKEN = "123456789:your-bot-token"
$env:TELEGRAM_CHAT_ID = "123456789"
npm start
```

Dashboard mode uses the same variables:

```powershell
$env:TELEGRAM_BOT_TOKEN = "123456789:your-bot-token"
$env:TELEGRAM_CHAT_ID = "123456789"
npm run dashboard
```

Quick way to find your chat ID:
1. Send any message to your bot in Telegram.
2. Open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`.
3. Use the `message.chat.id` value as `TELEGRAM_CHAT_ID`.

## Note

Quotes can be delayed depending on symbol/exchange.
This is a demo utility, not financial advice.
