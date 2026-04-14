const POLL_INTERVAL_MS = 8000;

const elements = {
  checkNowBtn: document.getElementById('checkNowBtn'),
  lastRefreshText: document.getElementById('lastRefreshText'),
  runningValue: document.getElementById('runningValue'),
  intervalValue: document.getElementById('intervalValue'),
  cooldownValue: document.getElementById('cooldownValue'),
  lastCheckValue: document.getElementById('lastCheckValue'),
  errorText: document.getElementById('errorText'),
  rulesGrid: document.getElementById('rulesGrid'),
  alertsList: document.getElementById('alertsList'),
  ruleCardTemplate: document.getElementById('ruleCardTemplate'),
  alertItemTemplate: document.getElementById('alertItemTemplate')
};

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return 'No quote';
  }

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

function titleCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function statusLabel(rule) {
  if (rule.status === 'cooldown') {
    const remainingSec = Math.max(0, Math.ceil((rule.cooldownRemainingMs ?? 0) / 1000));
    return `Cooldown ${remainingSec}s`;
  }

  return titleCase(rule.status);
}

function renderRules(rules) {
  elements.rulesGrid.textContent = '';

  if (!Array.isArray(rules) || rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No rules configured.';
    elements.rulesGrid.appendChild(empty);
    return;
  }

  for (const rule of rules) {
    const fragment = elements.ruleCardTemplate.content.cloneNode(true);
    fragment.querySelector('.rule-symbol').textContent = rule.displaySymbol;
    fragment.querySelector('.rule-market').textContent = rule.market;
    fragment.querySelector('.rule-price').textContent = formatPrice(rule.currentPrice);

    const targetText = `${titleCase(rule.condition)} ${formatPrice(rule.target)}`;
    fragment.querySelector('.rule-target').textContent = targetText;

    const badge = fragment.querySelector('.status-badge');
    badge.textContent = statusLabel(rule);
    badge.classList.add(`status-${rule.status}`);

    elements.rulesGrid.appendChild(fragment);
  }
}

function renderAlerts(alerts) {
  elements.alertsList.textContent = '';

  if (!Array.isArray(alerts) || alerts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No alerts yet.';
    elements.alertsList.appendChild(empty);
    return;
  }

  for (const alert of alerts) {
    const fragment = elements.alertItemTemplate.content.cloneNode(true);
    fragment.querySelector('.alert-text').textContent = alert.message;
    fragment.querySelector('.alert-time').textContent = alert.createdAtLabel;
    elements.alertsList.appendChild(fragment);
  }
}

function renderHeader(snapshot) {
  elements.runningValue.textContent = snapshot.running ? 'Running' : 'Stopped';
  elements.intervalValue.textContent = `${snapshot.checkIntervalSeconds}s`;
  elements.cooldownValue.textContent = `${snapshot.cooldownSeconds}s`;
  elements.lastCheckValue.textContent = snapshot.lastCheckAt
    ? new Date(snapshot.lastCheckAt).toLocaleString()
    : '--';
}

function setError(message) {
  if (!message) {
    elements.errorText.hidden = true;
    elements.errorText.textContent = '';
    return;
  }

  elements.errorText.hidden = false;
  elements.errorText.textContent = message;
}

async function fetchStatus() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Status request failed (${response.status})`);
  }
  return response.json();
}

async function fetchAndRender() {
  const snapshot = await fetchStatus();
  renderHeader(snapshot);
  renderRules(snapshot.ruleResults);
  renderAlerts(snapshot.alertHistory);
  setError(snapshot.lastError?.message ?? '');
  elements.lastRefreshText.textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;
}

async function forceCheck() {
  elements.checkNowBtn.disabled = true;

  try {
    const response = await fetch('/api/check', {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`Manual check failed (${response.status})`);
    }

    const snapshot = await response.json();
    renderHeader(snapshot);
    renderRules(snapshot.ruleResults);
    renderAlerts(snapshot.alertHistory);
    setError(snapshot.lastError?.message ?? '');
    elements.lastRefreshText.textContent = `Manual check at ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    setError(error.message);
  } finally {
    elements.checkNowBtn.disabled = false;
  }
}

elements.checkNowBtn.addEventListener('click', () => {
  void forceCheck();
});

async function start() {
  try {
    await fetchAndRender();
  } catch (error) {
    setError(error.message);
  }

  setInterval(() => {
    void fetchAndRender().catch((error) => {
      setError(error.message);
    });
  }, POLL_INTERVAL_MS);
}

void start();
