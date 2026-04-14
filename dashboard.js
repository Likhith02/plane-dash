#!/usr/bin/env node

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { PriceWatchMonitor, nowLabel } = require('./bot-core');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_ROOT = path.resolve(PUBLIC_DIR);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function printUsage() {
  console.log(`Price Watch Dashboard

Usage:
  node dashboard.js [--config <path>] [--port <number>] [--host <hostname>]

Options:
  --config <path>   Path to config JSON file (default: ./config.json)
  --port <number>   HTTP port (default: 3030)
  --host <hostname> Hostname to bind (default: 127.0.0.1)
  --help            Show this help message`);
}

function parseArgs(argv) {
  const args = {
    configPath: 'config.json',
    port: 3030,
    host: '127.0.0.1',
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

    if (arg === '--port') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('Expected a positive number after --port');
      }
      args.port = Math.floor(value);
      i += 1;
      continue;
    }

    if (arg === '--host') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Expected a hostname after --host');
      }
      args.host = value;
      i += 1;
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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function mapPublicPath(pathname) {
  if (pathname === '/') {
    return path.join(PUBLIC_DIR, 'index.html');
  }

  const relativePath = pathname.replace(/^\/+/, '');
  const normalized = path.normalize(relativePath);
  return path.join(PUBLIC_DIR, normalized);
}

async function serveStatic(pathname, response) {
  const filePath = path.resolve(mapPublicPath(pathname));
  if (filePath !== PUBLIC_ROOT && !filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] ?? 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    response.end(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendText(response, 404, 'Not found');
      return;
    }
    sendText(response, 500, 'Internal server error');
  }
}

function createStatusPayload(monitor) {
  return {
    generatedAt: new Date().toISOString(),
    generatedAtLabel: nowLabel(),
    ...monitor.getSnapshot()
  };
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

  monitor.on('error', (errorInfo) => {
    console.error(`[${errorInfo.atLabel}] Check failed: ${errorInfo.message}`);
  });

  monitor.start();

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (request.method === 'GET' && pathname === '/api/status') {
      sendJson(response, 200, createStatusPayload(monitor));
      return;
    }

    if (request.method === 'POST' && pathname === '/api/check') {
      await monitor.runSafeCheck();
      sendJson(response, 200, createStatusPayload(monitor));
      return;
    }

    if (request.method === 'GET') {
      await serveStatic(pathname, response);
      return;
    }

    sendText(response, 405, 'Method not allowed');
  });

  server.listen(args.port, args.host, () => {
    const localUrl = `http://${args.host}:${args.port}`;
    console.log(`Dashboard running at ${localUrl}`);
    console.log(`Using config: ${monitor.configPath}`);
    console.log('Press Ctrl+C to stop.');
  });

  const shutdown = () => {
    monitor.stop();
    server.close(() => {
      console.log(`Stopped dashboard at ${nowLabel()}.`);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[${nowLabel()}] Fatal error: ${error.message}`);
  process.exit(1);
});
