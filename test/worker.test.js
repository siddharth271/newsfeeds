import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const HOUR = 3600000;
const realFetch = globalThis.fetch;
let calls;
let openIssues;

const feedObject = body => ({
  body,
  httpEtag: '"abc"',
  writeHttpMetadata: headers => headers.set('content-type', 'application/json'),
  json: async () => JSON.parse(body),
});

const envWith = (files = {}) => ({
  GITHUB_REPO: 'owner/repo',
  GITHUB_TOKEN: 'test',
  FEEDS: { get: async key => (key in files ? feedObject(files[key]) : null) },
});

const manifestAt = time => ({ 'manifest.json': JSON.stringify({ generated_at: new Date(time).toISOString() }) });

async function runCron(env) {
  const waits = [];
  await worker.scheduled({ scheduledTime: NOW }, env, { waitUntil: promise => waits.push(promise) });
  await Promise.all(waits);
}

beforeEach(() => {
  calls = [];
  openIssues = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    return new Response(url.includes('state=open') ? JSON.stringify(openIssues) : '{}', { status: 200 });
  };
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async key => store.get(key.url)?.clone(),
      put: async (key, response) => void store.set(key.url, response),
    },
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.caches;
});

const get = (path, env) => worker.fetch(new Request(`https://feeds.test${path}`), env, { waitUntil: () => {} });

test('serves a feed and ignores the cache-busting query', async () => {
  const env = envWith({ 'top.json': '{"articles":[]}' });
  const response = await get('/static/top.json?t=123', env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(await response.text(), '{"articles":[]}');

  env.FEEDS.get = async () => { throw new Error('should come from the edge cache'); };
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await get('/static/top.json?t=456', env)).status, 200);
});

test('only feed paths are reachable', async () => {
  const env = envWith({ 'secret.txt': 'x', 'top.json': '{}' });
  assert.equal((await get('/secret.txt', env)).status, 404);
  assert.equal((await get('/static/../secret.txt', env)).status, 404);
  assert.equal((await get('/static/missing.json', env)).status, 404);
});

test('cron starts the pipeline and stays quiet while feeds are fresh', async () => {
  await runCron(envWith(manifestAt(NOW - HOUR)));
  assert.deepEqual(calls.map(call => call.method), ['POST']);
  assert.match(calls[0].url, /owner\/repo\/actions\/workflows\/publish\.yml\/dispatches$/);
  assert.equal(JSON.parse(calls[0].body).ref, 'main');
});

test('stale feeds open one issue', async () => {
  await runCron(envWith(manifestAt(NOW - 5 * HOUR)));
  const created = calls.find(call => call.url.endsWith('/issues') && call.method === 'POST');
  assert.match(JSON.parse(created.body).title, /5h old/);
});

test('an open alarm is not repeated', async () => {
  openIssues = [{ number: 1 }];
  await runCron(envWith(manifestAt(NOW - 5 * HOUR)));
  assert.equal(calls.some(call => call.url.endsWith('/issues') && call.method === 'POST'), false);
});

test('a missing manifest counts as stale', async () => {
  await runCron(envWith());
  assert.ok(calls.some(call => call.url.endsWith('/issues') && call.method === 'POST'));
});
