#!/usr/bin/env node
/**
 * Local dev server — mirrors Vercel routing from vercel.json.
 * Serves static HTML files and routes /api/* to serverless handler modules.
 *
 * Usage: node scripts/dev-server.js [port]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.argv[2] ?? process.env.PORT ?? '3000', 10);

// ── Vercel rewrites (source → destination handler path) ──────────────────────
const API_REWRITES = {
  '/api/stripe/checkout':     'api/stripe/checkout.js',
  '/api/webhooks/stripe':     'api/webhooks/stripe.js',
  '/api/webhooks/paypal':     'api/webhooks/paypal.js',
  '/api/webhooks/crossmint':  'api/webhooks/crossmint.js',
  '/api/portal/data':         'api/portal/data.js',
  '/api/health':              'api/health.js',
  '/api/email/send':          'api/email/send.js',
  '/api/crossmint/mint':      'api/crossmint/mint.js',
  '/api/paypal/create-order': 'api/paypal/create-order.js',
  '/api/paypal/capture':      'api/paypal/capture.js',
  '/api/member/claim':        'api/member/claim.js',
  // discord action routing
  '/api/discord/auth':             'api/discord.js',
  '/api/discord/callback':         'api/discord.js',
  '/api/discord/sync':             'api/discord.js',
  '/api/discord/check-membership': 'api/discord.js',
  '/api/discord':                  'api/discord.js',
  // cron (routed to existing handlers)
  '/api/cron/retry-mints':         'api/member/claim.js',
};

// ── Static page rewrites ──────────────────────────────────────────────────────
const PAGE_REWRITES = {
  '/aurevon-re':              'aurevon-re.html',
  '/aurevon-web3':            'aurevon-web3.html',
  '/aurevon-crm':             'aurevon-crm.html',
  '/aurevon-crm':              'aurevon-crm.html',
  '/portal':                  'portal.html',
  '/operator':                'operator.html',
  '/merch':                   'merch.html',
  '/discord-welcome':         'discord-welcome.html',
  '/membership-confirmation': 'membership_confirmation.html',
  '/setup-wizard':            'setup-wizard.html',
  '/member-claim':            'member-claim.html',
  '/success':                 'index.html',
  '/cancel':                  'index.html',
  '/nfts':                    'aurevon-web3.html',
};

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Request body reader ───────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Minimal req/res adapter for Vercel-style handlers ────────────────────────
function makeRes(nodeRes) {
  let headersSent = false;
  const res = {
    _headers: { 'Access-Control-Allow-Origin': '*' },
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    json(data) {
      if (!headersSent) {
        headersSent = true;
        nodeRes.writeHead(this.statusCode, { 'Content-Type': 'application/json', ...this._headers });
        nodeRes.end(JSON.stringify(data));
      }
    },
    send(data) {
      if (!headersSent) {
        headersSent = true;
        nodeRes.writeHead(this.statusCode, { 'Content-Type': 'text/plain', ...this._headers });
        nodeRes.end(typeof data === 'string' ? data : String(data));
      }
    },
    end(data) {
      if (!headersSent) {
        headersSent = true;
        nodeRes.writeHead(this.statusCode, this._headers);
        nodeRes.end(data ?? '');
      }
    },
  };
  return res;
}

// ── Static file server ────────────────────────────────────────────────────────
function serveStatic(filePath, nodeRes) {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] ?? 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    nodeRes.writeHead(200, { 'Content-Type': contentType });
    nodeRes.end(content);
  } catch {
    nodeRes.writeHead(404, { 'Content-Type': 'text/plain' });
    nodeRes.end('Not Found');
  }
}

// ── Main request handler ──────────────────────────────────────────────────────
async function handleRequest(req, nodeRes) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  nodeRes.setHeader('Access-Control-Allow-Origin', '*');
  nodeRes.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  nodeRes.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,stripe-signature');
  if (req.method === 'OPTIONS') {
    nodeRes.writeHead(200);
    nodeRes.end();
    return;
  }

  // API routes
  const apiHandler = API_REWRITES[pathname];
  if (apiHandler) {
    const handlerPath = path.join(ROOT, apiHandler);
    if (!fs.existsSync(handlerPath)) {
      nodeRes.writeHead(404, { 'Content-Type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const bodyBuffer = await readBody(req);
    const bodyStr = bodyBuffer.toString('utf8');

    let parsedBody = {};
    const ct = req.headers['content-type'] ?? '';
    if (ct.includes('application/json') && bodyStr) {
      try { parsedBody = JSON.parse(bodyStr); } catch { /* ignore */ }
    } else if (ct.includes('application/x-www-form-urlencoded') && bodyStr) {
      parsedBody = Object.fromEntries(new URLSearchParams(bodyStr));
    }

    const fakeReq = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      query: Object.fromEntries(url.searchParams),
      body: parsedBody,
      _rawBody: bodyStr,
      on(event, cb) {
        if (event === 'data' && bodyBuffer.length) setTimeout(() => cb(bodyBuffer), 0);
        if (event === 'end') setTimeout(cb, 1);
        return this;
      },
    };

    // Inject action query param for discord sub-routes and cron routes
    if (pathname.startsWith('/api/discord/')) {
      const action = pathname.replace('/api/discord/', '');
      fakeReq.query = { ...fakeReq.query, action };
    } else if (pathname === '/api/cron/retry-mints') {
      fakeReq.query = { ...fakeReq.query, action: 'retry-mints' };
    }

    const fakeRes = makeRes(nodeRes);

    try {
      const mod = await import(`${handlerPath}?t=${Date.now()}`);
      const handler = mod.default;
      await handler(fakeReq, fakeRes);
    } catch (err) {
      if (!nodeRes.writableEnded) {
        nodeRes.writeHead(500, { 'Content-Type': 'application/json' });
        nodeRes.end(JSON.stringify({ error: 'Internal server error', message: err.message }));
      }
    }
    return;
  }

  // Static page rewrites
  const rewrittenPage = PAGE_REWRITES[pathname];
  if (rewrittenPage) {
    serveStatic(path.join(ROOT, rewrittenPage), nodeRes);
    return;
  }

  // Direct file access
  const filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);

  // Try with and without .html extension (cleanUrls)
  if (fs.existsSync(filePath)) {
    serveStatic(filePath, nodeRes);
    return;
  }
  if (fs.existsSync(filePath + '.html')) {
    serveStatic(filePath + '.html', nodeRes);
    return;
  }

  // 404
  nodeRes.writeHead(404, { 'Content-Type': 'text/html' });
  nodeRes.end('<h1>404 Not Found</h1>');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('Unhandled error:', err);
    if (!res.writableEnded) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}`);
});
