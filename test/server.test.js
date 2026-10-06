'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

const env = {
  GITHUB_TOKEN: 'test-token',
  GITHUB_OWNER: 'beawart',
  GITHUB_REPO: 'plansurf-data',
  SESSION_SECRET: 'test-session-secret-with-at-least-32-bytes',
  APP_PASSWORD: 'shared-pass',
  APP_PASSWORD_BUDGET: 'budget-pass',
  APP_PASSWORD_DAILYSPARK: 'spark-pass',
  APP_PASSWORD_INVESTMENT: 'investment-pass',
  CORS_ORIGINS: 'https://beawart.github.io'
};

async function withServer(fetchImpl, run) {
  const server = createServer({ env, fetchImpl });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function signIn(baseUrl, app, password) {
  const response = await fetch(`${baseUrl}/api/${app}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://beawart.github.io' },
    body: JSON.stringify({ password })
  });
  return { response, body: await response.json() };
}

test('health is public and includes the configured CORS origin', async () => {
  await withServer(globalThis.fetch, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://beawart.github.io' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://beawart.github.io');
    assert.deepEqual(await response.json(), { ok: true, service: 'plansurf-service' });
  });
});

test('legacy Budget routes persist JSON and tokens cannot cross app boundaries', async () => {
  let storedBudget = null;
  const mockedGitHub = async (url, options = {}) => {
    assert.match(String(url), /plansurf\.budget-data\.json/);
    if (options.method === 'PUT') {
      storedBudget = JSON.parse(Buffer.from(JSON.parse(options.body).content, 'base64').toString('utf8'));
      return new Response('{}', { status: 200 });
    }
    if (storedBudget) {
      return new Response(JSON.stringify({ sha: 'file-sha', content: Buffer.from(JSON.stringify(storedBudget)).toString('base64') }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };

  await withServer(mockedGitHub, async (baseUrl) => {
    const loginResponse = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'budget-pass' })
    });
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const data = { app: 'plansurf-budget', transactions: { '2026-10': [] }, goals: [] };

    const saveResponse = await fetch(`${baseUrl}/api/budget`, { method: 'PUT', headers, body: JSON.stringify(data) });
    assert.equal(saveResponse.status, 200);
    assert.deepEqual(storedBudget, data);

    const readResponse = await fetch(`${baseUrl}/api/budget`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual(await readResponse.json(), data);

    const crossAppResponse = await fetch(`${baseUrl}/api/dailyspark/data`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(crossAppResponse.status, 401);
  });
});

test('DailySpark and Investment store data in separate app files', async () => {
  const writtenPaths = [];
  const mockedGitHub = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (options.method === 'PUT') {
      writtenPaths.push(path);
      return new Response('{}', { status: 200 });
    }
    return new Response('', { status: 404 });
  };

  await withServer(mockedGitHub, async (baseUrl) => {
    for (const [app, password, marker, expectedFile] of [
      ['dailyspark', 'spark-pass', 'plansurf-dailyspark', 'plansurf.daily-spark-data.json'],
      ['investment', 'investment-pass', 'plansurf-property', 'plansurf.property-data.json']
    ]) {
      const { response, body } = await signIn(baseUrl, app, password);
      assert.equal(response.status, 200);
      const saved = await fetch(`${baseUrl}/api/${app}/data`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: marker, records: [] })
      });
      assert.equal(saved.status, 200);
      assert.ok(writtenPaths.at(-1).endsWith(`/${expectedFile}`));
    }
    assert.equal(writtenPaths.length, 2);
  });
});

test('new app keys work with the shared password and get an isolated default file', async () => {
  let writtenPath = '';
  const mockedGitHub = async (url, options = {}) => {
    if (options.method === 'PUT') {
      writtenPath = new URL(url).pathname;
      return new Response('{}', { status: 200 });
    }
    return new Response('', { status: 404 });
  };

  await withServer(mockedGitHub, async (baseUrl) => {
    const { response, body } = await signIn(baseUrl, 'travel-notes', 'shared-pass');
    assert.equal(response.status, 200);
    const saved = await fetch(`${baseUrl}/api/travel-notes/data`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [] })
    });
    assert.equal(saved.status, 200);
    assert.ok(writtenPath.endsWith('/plansurf.travel-notes-data.json'));

    const invalidKey = await fetch(`${baseUrl}/api/not_valid/data`, {
      headers: { Authorization: `Bearer ${body.token}` }
    });
    assert.equal(invalidKey.status, 404);
  });
});

test('unknown origins and invalid Budget payloads are rejected', async () => {
  await withServer(globalThis.fetch, async (baseUrl) => {
    const blockedOrigin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'budget-pass' })
    });
    assert.equal(blockedOrigin.status, 403);

    const { body: login } = await signIn(baseUrl, 'budget', 'budget-pass');
    const invalidData = await fetch(`${baseUrl}/api/budget`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: {}, goals: [] })
    });
    assert.equal(invalidData.status, 400);
  });
});
