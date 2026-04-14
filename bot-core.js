const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const USER_AGENT = 'price-watch-bot/1.0';
const DEFAULT_MAX_ALERT_HISTORY = 100;

function nowLabel(date = new Date()) {
  return date.toLocaleString();
}

function formatPrice(value) {
  const abs = Math.abs(value);
  let decimals = 2;

  if (abs < 1) {
    decimals = 6;
  } else if (abs < 100) {
    decimals = 4;
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(value);
}

function validateConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Config must be a JSON object');
  }

  const checkIntervalSeconds = Number(rawConfig.checkIntervalSeconds ?? 60);
  const cooldownSeconds = Number(rawConfig.cooldownSeconds ?? 300);

  if (!Number.isFinite(checkIntervalSeconds) || checkIntervalSeconds <= 0) {
    throw new Error('checkIntervalSeconds must be a positive number');
  }

  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0) {
    throw new Error('cooldownSeconds must be a non-negative number');
  }

  if (!Array.isArray(rawConfig.rules) || rawConfig.rules.length === 0) {
    throw new Error('rules must be a non-empty array');
  }

  const rules = rawConfig.rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object') {
      throw new Error(`rules[${index}] must be an object`);
    }

    const rawSymbol = String(rule.symbol ?? '').trim();
    const market = String(rule.market ?? '').trim().toLowerCase();
    const condition = String(rule.condition ?? '').trim().toLowerCase();
    const target = Number(rule.target);
    const label = typeof rule.label === 'string' ? rule.label.trim() : '';

    if (!rawSymbol) {
      throw new Error(`rules[${index}].symbol is required`);
    }

    if (market !== 'stock' && market !== 'crypto') {
      throw new Error(`rules[${index}].market must be "stock" or "crypto"`);
    }

    if (condition !== 'above' && condition !== 'below') {
      throw new Error(`rules[${index}].condition must be "above" or "below"`);
    }

    if (!Number.isFinite(target)) {
      throw new Error(`rules[${index}].target must be a number`);
    }

    let normalizedSymbol = rawSymbol.toLowerCase();

    if (market === 'stock' && !normalizedSymbol.includes('.')) {
      normalizedSymbol = `${normalizedSymbol}.us`;
    }

    return {
      market,
      symbol: normalizedSymbol,
      displaySymbol: label || rawSymbol.toUpperCase(),
      condition,
      target
    };
  });

  return {
    checkIntervalMs: Math.floor(checkIntervalSeconds * 1000),
    cooldownMs: Math.floor(cooldownSeconds * 1000),
    rules
  };
}

async function loadConfig(configPath) {
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Config file is not valid JSON: ${configPath}`);
  }

  return validateConfig(parsed);
}

async function fetchStockPrices(symbols) {
  const symbolsParam = encodeURIComponent(symbols.join('+'));
  const url = `https://stooq.com/q/l/?s=${symbolsParam}&i=d`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Stock API request failed (${response.status})`);
  }

  const text = await response.text();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const prices = new Map();

  for (const line of lines) {
    const columns = line.split(',');
    if (columns.length < 7) {
      continue;
    }

    const symbol = String(columns[0] ?? '').trim().toLowerCase();
    const close = Number.parseFloat(String(columns[6] ?? '').trim());

    if (!symbol || !Number.isFinite(close)) {
      continue;
    }

    prices.set(symbol, close);
  }

  return prices;
}

async function fetchCryptoPrices(ids) {
  const idsParam = encodeURIComponent(ids.join(','));
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${idsParam}&vs_currencies=usd`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Crypto API request failed (${response.status})`);
  }

  const data = await response.json();
  const prices = new Map();

  for (const id of ids) {
    const value = data?.[id]?.usd;
    if (Number.isFinite(value)) {
      prices.set(id, value);
    }
  }

  return prices;
}

async function fetchPricesForRules(rules) {
  const stockSymbols = [...new Set(rules.filter((rule) => rule.market === 'stock').map((rule) => rule.symbol))];
  const cryptoIds = [...new Set(rules.filter((rule) => rule.market === 'crypto').map((rule) => rule.symbol))];

  const [stockPrices, cryptoPrices] = await Promise.all([
    stockSymbols.length > 0 ? fetchStockPrices(stockSymbols) : Promise.resolve(new Map()),
    cryptoIds.length > 0 ? fetchCryptoPrices(cryptoIds) : Promise.resolve(new Map())
  ]);

  const merged = new Map();

  for (const [symbol, price] of stockPrices.entries()) {
    merged.set(`stock:${symbol}`, price);
  }

  for (const [symbol, price] of cryptoPrices.entries()) {
    merged.set(`crypto:${symbol}`, price);
  }

  return merged;
}

function isTriggered(rule, currentPrice) {
  if (rule.condition === 'above') {
    return currentPrice > rule.target;
  }

  return currentPrice < rule.target;
}

function ruleKey(rule) {
  return `${rule.market}:${rule.symbol}|${rule.condition}|${rule.target}`;
}

function lookupKey(rule) {
  return `${rule.market}:${rule.symbol}`;
}

async function postTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) {
    return false;
  }

  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          disable_web_page_preview: true
        })
      });

      const payload = await response.json();
      if (response.ok && payload?.ok === true) {
        return true;
      }

      const retryAfter = Number(payload?.parameters?.retry_after);
      if (attempt === 0 && Number.isFinite(retryAfter) && retryAfter > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
    } catch (error) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
    }

    return false;
  }

  return false;
}

function createUnknownRuleSnapshot(rule) {
  return {
    market: rule.market,
    symbol: rule.symbol,
    displaySymbol: rule.displaySymbol,
    condition: rule.condition,
    target: rule.target,
    currentPrice: null,
    status: 'unknown',
    triggered: false,
    onCooldown: false,
    cooldownRemainingMs: 0
  };
}

class PriceWatchMonitor extends EventEmitter {
  constructor({ config, configPath, telegramBotToken, telegramChatId, maxAlertHistory = DEFAULT_MAX_ALERT_HISTORY }) {
    super();
    this.config = config;
    this.configPath = configPath;
    this.telegramBotToken = telegramBotToken ?? '';
    this.telegramChatId = telegramChatId ?? '';
    this.maxAlertHistory = maxAlertHistory;
    this.timer = null;
    this.lastAlertAt = new Map();
    this.checkInProgress = false;
    this.lastCheckAt = null;
    this.nextCheckAt = null;
    this.lastDurationMs = null;
    this.lastError = null;
    this.lastRuleResults = config.rules.map((rule) => createUnknownRuleSnapshot(rule));
    this.alertHistory = [];
  }

  static async fromConfigPath(configPath, options = {}) {
    const resolvedConfigPath = path.resolve(process.cwd(), configPath);
    const config = await loadConfig(resolvedConfigPath);

    return new PriceWatchMonitor({
      config,
      configPath: resolvedConfigPath,
      telegramBotToken: options.telegramBotToken ?? '',
      telegramChatId: options.telegramChatId ?? '',
      maxAlertHistory: options.maxAlertHistory ?? DEFAULT_MAX_ALERT_HISTORY
    });
  }

  async runCheck() {
    if (this.checkInProgress) {
      return { skipped: true, reason: 'check_in_progress' };
    }

    this.checkInProgress = true;
    const startedAt = Date.now();
    const checkedAtIso = new Date(startedAt).toISOString();

    try {
      const prices = await fetchPricesForRules(this.config.rules);
      const ruleResults = [];
      const newAlerts = [];

      for (const rule of this.config.rules) {
        const currentPrice = prices.get(lookupKey(rule));

        if (!Number.isFinite(currentPrice)) {
          ruleResults.push({
            ...createUnknownRuleSnapshot(rule),
            status: 'missing'
          });
          continue;
        }

        const triggered = isTriggered(rule, currentPrice);
        const lastAlert = this.lastAlertAt.get(ruleKey(rule)) ?? 0;
        const cooldownRemainingMs = Math.max(0, this.config.cooldownMs - (startedAt - lastAlert));
        const onCooldown = triggered && cooldownRemainingMs > 0;

        let status = 'ok';
        if (triggered && onCooldown) {
          status = 'cooldown';
        } else if (triggered) {
          status = 'triggered';
        }

        ruleResults.push({
          market: rule.market,
          symbol: rule.symbol,
          displaySymbol: rule.displaySymbol,
          condition: rule.condition,
          target: rule.target,
          currentPrice,
          status,
          triggered,
          onCooldown,
          cooldownRemainingMs
        });

        if (!triggered || onCooldown) {
          continue;
        }

        this.lastAlertAt.set(ruleKey(rule), startedAt);

        const direction = rule.condition === 'above' ? 'rose above' : 'fell below';
        const message = `[PRICE ALERT] ${rule.displaySymbol} (${rule.market}) ${direction} ${formatPrice(rule.target)}. Current price: ${formatPrice(currentPrice)} (${nowLabel(new Date(startedAt))})`;
        const telegramSent = await postTelegram(this.telegramBotToken, this.telegramChatId, message);

        newAlerts.push({
          id: `${startedAt}-${newAlerts.length + 1}`,
          createdAt: checkedAtIso,
          createdAtLabel: nowLabel(new Date(startedAt)),
          message,
          market: rule.market,
          displaySymbol: rule.displaySymbol,
          condition: rule.condition,
          target: rule.target,
          currentPrice,
          telegramSent
        });
      }

      this.lastCheckAt = checkedAtIso;
      this.lastDurationMs = Date.now() - startedAt;
      this.lastError = null;
      this.lastRuleResults = ruleResults;

      if (newAlerts.length > 0) {
        this.alertHistory = [...newAlerts, ...this.alertHistory].slice(0, this.maxAlertHistory);
      }

      const summary = {
        checkedAt: checkedAtIso,
        checkedAtLabel: nowLabel(new Date(startedAt)),
        durationMs: this.lastDurationMs,
        ruleResults,
        newAlerts
      };

      this.emit('check', summary);
      if (newAlerts.length > 0) {
        this.emit('alerts', newAlerts);
      }

      return summary;
    } catch (error) {
      this.lastError = {
        message: error.message,
        at: new Date().toISOString(),
        atLabel: nowLabel()
      };
      this.emit('error', this.lastError);
      throw error;
    } finally {
      this.checkInProgress = false;
    }
  }

  async runSafeCheck() {
    try {
      return await this.runCheck();
    } catch (error) {
      return null;
    }
  }

  start() {
    if (this.timer) {
      return;
    }

    void this.runSafeCheck();
    this.nextCheckAt = new Date(Date.now() + this.config.checkIntervalMs).toISOString();

    this.timer = setInterval(() => {
      this.nextCheckAt = new Date(Date.now() + this.config.checkIntervalMs).toISOString();
      void this.runSafeCheck();
    }, this.config.checkIntervalMs);
  }

  stop() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
  }

  getSnapshot() {
    return {
      configPath: this.configPath,
      checkIntervalSeconds: Math.round(this.config.checkIntervalMs / 1000),
      cooldownSeconds: Math.round(this.config.cooldownMs / 1000),
      running: Boolean(this.timer),
      checkInProgress: this.checkInProgress,
      lastCheckAt: this.lastCheckAt,
      nextCheckAt: this.nextCheckAt,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError,
      ruleResults: this.lastRuleResults.map((rule) => ({ ...rule })),
      alertHistory: this.alertHistory.map((alert) => ({ ...alert }))
    };
  }
}

module.exports = {
  PriceWatchMonitor,
  formatPrice,
  loadConfig,
  nowLabel,
  validateConfig
};
