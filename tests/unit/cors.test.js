import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';

import {
  LOCAL_ADMIN_PORTAL_ORIGINS,
  createCorsMiddleware,
  parseAllowedOrigins,
  resolveAllowedOrigins,
} from '../../src/middleware/cors.middleware.js';

const STAGING_PORTAL = 'http://13.233.157.200:4173';

const withServer = async (allowed, run) => {
  const app = express();
  app.use(createCorsMiddleware(allowed));
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('parses exact origins and drops blanks and a trailing slash', () => {
  assert.deepEqual(parseAllowedOrigins(` ${STAGING_PORTAL}/ , ,https://admin.example.com`), [
    STAGING_PORTAL,
    'https://admin.example.com',
  ]);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

test('rejects wildcards, paths and non-http origins', () => {
  assert.throws(() => parseAllowedOrigins('*'), /wildcard/);
  assert.throws(() => parseAllowedOrigins('https://*.example.com'), /wildcard/);
  assert.throws(() => parseAllowedOrigins('http://host:4173/admin'), /bare origins/);
  assert.throws(() => parseAllowedOrigins('ftp://host'), /bare origins/);
  assert.throws(() => parseAllowedOrigins('not a url'), /invalid origin/);
});

test('local portal origins are trusted only outside production', () => {
  const dev = resolveAllowedOrigins({ configured: STAGING_PORTAL, isProduction: false });
  assert.ok(dev.includes('http://localhost:5173'));
  assert.ok(dev.includes(STAGING_PORTAL));

  const prod = resolveAllowedOrigins({ configured: STAGING_PORTAL, isProduction: true });
  assert.deepEqual(prod, [STAGING_PORTAL]);
});

test('an allowed origin gets credentialed CORS headers', async () => {
  await withServer([...LOCAL_ADMIN_PORTAL_ORIGINS], async (base) => {
    const res = await fetch(`${base}/api/ping`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.match(res.headers.get('vary'), /Origin/);
  });
});

test('a preflight from an allowed origin is answered with the allowed methods and headers', async () => {
  await withServer([STAGING_PORTAL], async (base) => {
    const res = await fetch(`${base}/api/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: STAGING_PORTAL,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), STAGING_PORTAL);
    assert.match(res.headers.get('access-control-allow-methods'), /PATCH/);
    assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
  });
});

test('an untrusted origin gets no CORS headers', async () => {
  await withServer([STAGING_PORTAL], async (base) => {
    const res = await fetch(`${base}/api/ping`, { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);

    const preflight = await fetch(`${base}/api/ping`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'DELETE' },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  });
});

test('requests without an Origin (the mobile app) are untouched', async () => {
  await withServer([STAGING_PORTAL], async (base) => {
    const res = await fetch(`${base}/api/ping`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});
