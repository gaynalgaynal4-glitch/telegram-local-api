'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 10000);
const API_PORT = Number(process.env.TELEGRAM_HTTP_PORT || 8081);
const API_ID = process.env.TELEGRAM_API_ID;
const API_HASH = process.env.TELEGRAM_API_HASH;
const WORK_DIR = path.resolve(process.env.TELEGRAM_WORK_DIR || '/tmp/telegram-bot-api-data');
const TEMP_DIR = path.resolve(process.env.TELEGRAM_TEMP_DIR || '/tmp/telegram-bot-api-temp');
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_MB || 210) * 1024 * 1024;
const CLEANUP_TOKEN = process.env.CLEANUP_TOKEN || '';

if (!API_ID || !API_HASH) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH.');
  process.exit(1);
}
if (!CLEANUP_TOKEN) {
  console.error('Missing CLEANUP_TOKEN. Set a secret token in Render.');
  process.exit(1);
}

fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

const args = [
  `--api-id=${API_ID}`,
  `--api-hash=${API_HASH}`,
  '--local',
  `--http-port=${API_PORT}`,
  '--http-ip-address=127.0.0.1',
  `--dir=${WORK_DIR}`,
  `--temp-dir=${TEMP_DIR}`,
];

console.log(`Starting Telegram Bot API engine on 127.0.0.1:${API_PORT}`);
const telegram = spawn('/usr/local/bin/telegram-bot-api', args, {
  stdio: 'inherit',
  env: process.env,
});

telegram.on('error', (err) => {
  console.error('Failed to start Telegram Bot API:', err);
  process.exit(1);
});

telegram.on('exit', (code, signal) => {
  console.error(`Telegram Bot API exited (code=${code}, signal=${signal}).`);
  process.exit(code || 1);
});

function inside(dir, candidate) {
  const relative = path.relative(dir, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isAllowedPath(candidate) {
  return inside(WORK_DIR, candidate) || inside(TEMP_DIR, candidate);
}

function sendJson(res, status, value) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');

    req.on('data', chunk => {
      body += chunk;

      if (Buffer.byteLength(body) > limit) {
        reject(new Error('JSON body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

async function deleteExactFile(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error('Each path must be an absolute path returned by this Telegram API server.');
  }

  const absolute = path.resolve(candidate);

  if (!isAllowedPath(absolute)) {
    throw new Error('Refusing to delete a path outside Telegram temporary storage.');
  }

  let real;

  try {
    real = await fs.promises.realpath(absolute);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        path: absolute,
        deleted: false,
        reason: 'already_missing'
      };
    }

    throw err;
  }

  if (!isAllowedPath(real)) {
    throw new Error('Resolved path is outside Telegram temporary storage.');
  }

  const stat = await fs.promises.lstat(real);

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Only regular files can be deleted.');
  }

  await fs.promises.unlink(real);

  return {
    path: absolute,
    deleted: true
  };
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  // Health check
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      service: 'telegram-local-bot-api',
      uploadRequestLimitMB: Number(process.env.MAX_REQUEST_MB || 210),
      cleanup: 'immediate_after_bot_callback',
    });
  }

  // Secure cleanup endpoint
  if (pathname === '/cleanup' && req.method === 'POST') {
    if (req.headers['x-cleanup-token'] !== CLEANUP_TOKEN) {
      req.resume();
      return sendJson(res, 401, {
        ok: false,
        error: 'Unauthorized'
      });
    }

    try {
      const body = await readJson(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];

      if (paths.length < 1 || paths.length > 100) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Provide between 1 and 100 paths.'
        });
      }

      const results = [];

      for (const filePath of paths) {
        results.push(await deleteExactFile(filePath));
      }

      return sendJson(res, 200, {
        ok: true,
        cleanup: 'immediate',
        results
      });
    } catch (err) {
      return sendJson(res, 400, {
        ok: false,
        error: err.message
      });
    }
  }

  // Secure local-mode file download endpoint
  if (pathname === '/download' && req.method === 'GET') {
    if (req.headers['x-cleanup-token'] !== CLEANUP_TOKEN) {
      return sendJson(res, 401, {
        ok: false,
        error: 'Unauthorized'
      });
    }

    try {
      const requestedPath =
        new URL(req.url, 'http://localhost').searchParams.get('path');

      if (!requestedPath || !path.isAbsolute(requestedPath)) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Invalid file path.'
        });
      }

      const absolute = path.resolve(requestedPath);

      if (!isAllowedPath(absolute)) {
        return sendJson(res, 403, {
          ok: false,
          error: 'File path not allowed.'
        });
      }

      const real = await fs.promises.realpath(absolute);

      if (!isAllowedPath(real)) {
        return sendJson(res, 403, {
          ok: false,
          error: 'Resolved file path not allowed.'
        });
      }

      const stat = await fs.promises.stat(real);

      if (!stat.isFile()) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Not a regular file.'
        });
      }

      if (stat.size > MAX_REQUEST_BYTES) {
        return sendJson(res, 413, {
          ok: false,
          error: `File exceeds ${Math.floor(MAX_REQUEST_BYTES / 1048576)} MiB.`
        });
      }

      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-store',
      });

      const stream = fs.createReadStream(real);

      stream.on('error', err => {
        console.error('[download] File stream error:', err.message);
        res.destroy(err);
      });

      stream.pipe(res);
      return;

    } catch (err) {
      console.error('[download] Route error:', err.message);

      if (!res.headersSent) {
        return sendJson(res, 404, {
          ok: false,
          error: 'File not found.'
        });
      }

      res.destroy(err);
      return;
    }
  }

  // Limit all Telegram API request bodies
  const declaredLength = Number(req.headers['content-length'] || 0);

  if (declaredLength > MAX_REQUEST_BYTES) {
    req.resume();

    return sendJson(res, 413, {
      ok: false,
      error: `Request exceeds ${Math.floor(MAX_REQUEST_BYTES / 1024 / 1024)} MiB.`,
    });
  }

  // Stream requests to Telegram without buffering large videos in RAM
  const upstream = http.request({
    host: '127.0.0.1',
    port: API_PORT,
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${API_PORT}`
    },
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  let received = 0;

  req.on('data', chunk => {
    received += chunk.length;

    if (received > MAX_REQUEST_BYTES) {
      upstream.destroy();

      if (!res.headersSent) {
        sendJson(res, 413, {
          ok: false,
          error: `Request exceeds ${Math.floor(MAX_REQUEST_BYTES / 1024 / 1024)} MiB.`,
        });
      }

      req.destroy();
    }
  });

  req.on('error', err => upstream.destroy(err));

  upstream.on('error', err => {
    console.error('Telegram API proxy error:', err.message);

    if (!res.headersSent) {
      sendJson(res, 502, {
        ok: false,
        error: 'Telegram API engine unavailable.'
      });
    } else {
      res.destroy(err);
    }
  });

  req.pipe(upstream);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Node gateway listening on 0.0.0.0:${PORT}`);
  console.log(`Maximum request body: ${Math.floor(MAX_REQUEST_BYTES / 1048576)} MiB`);
});

function shutdown() {
  console.log('Shutting down services...');
  server.close();
  telegram.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
