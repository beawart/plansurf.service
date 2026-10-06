'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const APP_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const APPS = Object.freeze({
  budget: {
    passwordEnv: 'APP_PASSWORD_BUDGET',
    pathEnv: 'GITHUB_PATH_BUDGET',
    defaultPath: 'plansurf.budget-data.json',
    marker: 'plansurf-budget'
  },
  dailyspark: {
    passwordEnv: 'APP_PASSWORD_DAILYSPARK',
    pathEnv: 'GITHUB_PATH_DAILYSPARK',
    defaultPath: 'plansurf.daily-spark-data.json',
    marker: 'plansurf-dailyspark'
  },
  investment: {
    passwordEnv: 'APP_PASSWORD_INVESTMENT',
    pathEnv: 'GITHUB_PATH_INVESTMENT',
    defaultPath: 'plansurf.property-data.json',
    marker: 'plansurf-property'
  }
});

function isValidAppKey(app) {
  return typeof app === 'string' && APP_KEY_PATTERN.test(app);
}

function readConfig(env) {
  const allowedOrigins = (env.CORS_ORIGINS || env.CORS_ORIGIN || 'https://beawart.github.io')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    githubToken: env.GITHUB_TOKEN || '',
    githubOwner: env.GITHUB_OWNER || 'beawart',
    githubRepo: env.GITHUB_REPO || 'plansurf-data',
    githubBranch: env.GITHUB_BRANCH || 'main',
    sessionSecret: env.SESSION_SECRET || '',
    sharedPassword: env.APP_PASSWORD || '',
    allowedOrigins,
  };
}

function getAppConfig(app, env, sharedPassword) {
  const known = APPS[app] || {};
  const suffix = app.toUpperCase().replace(/-/g, '_');
  const passwordEnv = known.passwordEnv || `APP_PASSWORD_${suffix}`;
  const pathEnv = known.pathEnv || `GITHUB_PATH_${suffix}`;
  return {
    passwordEnv,
    password: env[passwordEnv] || sharedPassword,
    path: env[pathEnv] || known.defaultPath || `plansurf.${app}-data.json`,
    marker: known.marker || `plansurf-${app}`
  };
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function encodeGitHubPath(pathValue) {
  return pathValue.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function createSessionToken(app, secret) {
  const payload = Buffer.from(JSON.stringify({
    app,
    exp: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomBytes(12).toString('base64url')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getBearerToken(req) {
  const match = (req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_.-]+)$/);
  return match ? match[1] : '';
}

function tokenApp(token, secret) {
  if (!token || !secret) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!secureEqual(signature, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.exp > Date.now() && isValidAppKey(claims.app) ? claims.app : null;
  } catch {
    return null;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createServer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = readConfig(env);
  const loginAttempts = new Map();
  const revokedSessions = new Map();
  const appConfig = (app) => getAppConfig(app, env, config.sharedPassword);

  function send(res, status, payload, origin = '') {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      Vary: 'Origin'
    };
    if (origin && config.allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
  }

  function serviceReady(app) {
    const missing = [];
    if (!config.githubToken) missing.push('GITHUB_TOKEN');
    if (!config.sessionSecret || Buffer.byteLength(config.sessionSecret) < 32) missing.push('SESSION_SECRET (at least 32 bytes)');
    if (!appConfig(app).password) missing.push(appConfig(app).passwordEnv);
    return missing.length ? `The API is missing required configuration: ${missing.join(', ')}.` : '';
  }

  function rateLimitKey(req) {
    const forwarded = req.headers['x-forwarded-for'];
    return (forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
  }

  function loginRateLimited(req) {
    const key = rateLimitKey(req);
    const freshAttempts = (loginAttempts.get(key) || []).filter((time) => Date.now() - time < LOGIN_WINDOW_MS);
    loginAttempts.set(key, freshAttempts);
    return freshAttempts.length >= MAX_LOGIN_ATTEMPTS;
  }

  function recordLoginAttempt(req) {
    const key = rateLimitKey(req);
    loginAttempts.set(key, [...(loginAttempts.get(key) || []), Date.now()]);
  }

  function sessionIsValid(req, app) {
    const token = getBearerToken(req);
    if (!token || revokedSessions.has(token)) return false;
    return tokenApp(token, config.sessionSecret) === app;
  }

  async function fetchDataFile(app) {
    const fileUrl = `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodeGitHubPath(appConfig(app).path)}?ref=${encodeURIComponent(config.githubBranch)}`;
    const response = await fetchImpl(fileUrl, {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (response.status === 404) return { exists: false, data: null, sha: null };
    if (!response.ok) throw new Error(`GitHub read failed (${response.status}).`);

    const file = await response.json();
    if (!file.content) return { exists: false, data: null, sha: null };
    const raw = Buffer.from(file.content, 'base64').toString('utf8');
    return { exists: true, data: raw ? JSON.parse(raw) : null, sha: file.sha };
  }

  async function saveDataFile(app, value) {
    const settings = appConfig(app);
    const existing = await fetchDataFile(app);
    const fileUrl = `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodeGitHubPath(settings.path)}`;
    const response = await fetchImpl(fileUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `Update ${app} data`,
        content: Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64'),
        ...(existing.exists ? { sha: existing.sha } : {}),
        branch: config.githubBranch
      })
    });

    if (response.status === 409 || response.status === 422) {
      throw Object.assign(new Error('The data changed during this save. Pull the latest data and try again.'), { statusCode: 409 });
    }
    if (!response.ok) throw new Error(`GitHub write failed (${response.status}).`);
  }

  async function handle(req, res) {
    const requestUrl = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin || '';
    const route = requestUrl.pathname.split('/').filter(Boolean);

    if (origin && !config.allowedOrigins.includes(origin)) {
      send(res, 403, { error: 'This origin is not allowed.' });
      return;
    }
    if (req.method === 'OPTIONS') {
      send(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      send(res, 200, { ok: true, service: 'plansurf-service' }, origin);
      return;
    }

    let app;
    let action;
    if (route[0] === 'api' && route.length === 2 && route[1] === 'login') {
      app = 'budget';
      action = 'login';
    } else if (route[0] === 'api' && route.length === 2 && route[1] === 'logout') {
      app = 'budget';
      action = 'logout';
    } else if (route[0] === 'api' && route.length === 2 && route[1] === 'budget') {
      app = 'budget';
      action = 'data';
    } else if (route[0] === 'api' && route.length === 3 && isValidAppKey(route[1])) {
      [app, action] = [route[1], route[2]];
    }

    if (!app || !['login', 'logout', 'data'].includes(action)) {
      send(res, 404, { error: 'Not found.' }, origin);
      return;
    }

    if (action === 'login' && req.method === 'POST') {
      const unavailable = serviceReady(app);
      if (unavailable) {
        send(res, 503, { error: unavailable }, origin);
        return;
      }
      if (loginRateLimited(req)) {
        send(res, 429, { error: 'Too many login attempts. Try again in 15 minutes.' }, origin);
        return;
      }
      try {
        const body = await readJsonBody(req);
        recordLoginAttempt(req);
        if (typeof body.password !== 'string' || !secureEqual(body.password, appConfig(app).password)) {
          send(res, 401, { error: 'Incorrect password.' }, origin);
          return;
        }
        send(res, 200, { token: createSessionToken(app, config.sessionSecret), expiresIn: SESSION_TTL_MS }, origin);
      } catch (error) {
        send(res, error.statusCode || 400, { error: error.message || 'Invalid request.' }, origin);
      }
      return;
    }

    if (action === 'logout' && req.method === 'POST') {
      const token = getBearerToken(req);
      if (sessionIsValid(req, app)) {
        revokedSessions.set(token, Date.now() + SESSION_TTL_MS);
        for (const [revokedToken, expiry] of revokedSessions) {
          if (expiry <= Date.now()) revokedSessions.delete(revokedToken);
        }
      }
      send(res, 200, { ok: true }, origin);
      return;
    }

    if (action !== 'data' || !['GET', 'PUT'].includes(req.method)) {
      send(res, 404, { error: 'Not found.' }, origin);
      return;
    }
    const unavailable = serviceReady(app);
    if (unavailable) {
      send(res, 503, { error: unavailable }, origin);
      return;
    }
    if (!sessionIsValid(req, app)) {
      send(res, 401, { error: 'Please sign in to use this app.' }, origin);
      return;
    }

    try {
      if (req.method === 'GET') {
        const result = await fetchDataFile(app);
        const initialData = app === 'budget' ? { transactions: {}, goals: [] } : {};
        send(res, 200, result.exists && result.data ? result.data : initialData, origin);
        return;
      }

      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        send(res, 400, { error: 'Data must be a JSON object.' }, origin);
        return;
      }
      if (body.app && body.app !== appConfig(app).marker) {
        send(res, 400, { error: 'The data app marker does not match this endpoint.' }, origin);
        return;
      }
      if (app === 'budget' && (body.app !== 'plansurf-budget' || !body.transactions || typeof body.transactions !== 'object' || Array.isArray(body.transactions) || !Array.isArray(body.goals))) {
        send(res, 400, { error: 'Budget data must include the PlanSurf app marker, transactions, and goals.' }, origin);
        return;
      }

      await saveDataFile(app, body);
      send(res, 200, { ok: true, message: `${app} data saved.` }, origin);
    } catch (error) {
      send(res, error.statusCode || 500, { error: error.message || 'Unable to access the data file.' }, origin);
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { error: 'The request could not be completed.' }));
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(Number(process.env.PORT || 3001), () => {
    console.log(`PlanSurf service listening on port ${process.env.PORT || 3001}`);
  });
}

module.exports = { APPS, createServer };
