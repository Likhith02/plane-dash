#!/usr/bin/env node

const path = require('node:path');
const { PriceWatchMonitor, formatPrice, nowLabel } = require('./bot-core');

function printUsage() {
  console.log(`Price Watch Bot

Usage:
  node index.js [--config <path>] [--once]

Options:
  --config <path>   Path to config JSON file (default: ./config.json)
  --once            Run a single check and exit
  --help            Show this help message

Rule markets:
  stock   Uses Stooq (example symbol: AAPL)
  crypto  Uses CoinGecko (example symbol: bitcoin)`);
}

function parseArgs(argv) {
  const args = {
    configPath: 'config.json',
    once: false,
    help: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--config') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Expected a file path after --config');
      }
      args.configPath = value;
      i += 1;
      continue;
    }

    if (arg === '--once') {
      args.once = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printRuleResult(result) {
  if (!Number.isFinite(result.currentPrice)) {
    console.log(`  - ${result.displaySymbol} (${result.market}): no price returned`);
    return;
  }

  let statusText = result.status.toUpperCase();
  if (result.status === 'cooldown') {
    const remainingSec = Math.ceil(result.cooldownRemainingMs / 1000);
    statusText = `COOLDOWN (${remainingSec}s)`;
  }

  console.log(
    `  - ${result.displaySymbol} (${result.market}): ${formatPrice(result.currentPrice)} | ${result.condition} ${formatPrice(result.target)} | ${statusText}`
  );
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    return;
  }

  const resolvedConfigPath = path.resolve(process.cwd(), args.configPath);
  const monitor = await PriceWatchMonitor.fromConfigPath(resolvedConfigPath, {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID
  });

  console.log(`Using config: ${monitor.configPath}`);
  console.log(`Check interval: ${Math.round(monitor.config.checkIntervalMs / 1000)}s`);
  console.log(`Cooldown: ${Math.round(monitor.config.cooldownMs / 1000)}s`);

  monitor.on('check', (summary) => {
    console.log(`\n[${summary.checkedAtLabel}] Checked ${summary.ruleResults.length} rule(s).`);
    for (const result of summary.ruleResults) {
      printRuleResult(result);
    }
  });

  monitor.on('alerts', (alerts) => {
    for (const alert of alerts) {
      process.stdout.write('\u0007');
      console.log(`\n>>> ${alert.message}`);
      if (monitor.telegramBotToken && monitor.telegramChatId) {
        console.log(alert.telegramSent ? '    Telegram alert sent.' : '    Telegram alert failed.');
      }
    }
  });

  monitor.on('error', (errorInfo) => {
    console.error(`[${errorInfo.atLabel}] Check failed: ${errorInfo.message}`);
  });

  await monitor.runSafeCheck();

  if (args.once) {
    return;
  }

  monitor.start();
  console.log('\nMonitoring started. Press Ctrl+C to stop.');

  process.on('SIGINT', () => {
    monitor.stop();
    console.log(`\nStopped monitoring at ${nowLabel()}.`);
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`[${nowLabel()}] Fatal error: ${error.message}`);
  process.exit(1);
});
