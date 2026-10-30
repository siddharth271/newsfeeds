import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const HOUR = 3600000;
const realFetch = globalThis.fetch;
const env = { GITHUB_REPO: 'owner/repo', GITHUB_TOKEN: 'test', FEED_BASE: 'https://feeds.test/static' };
let calls;
let openIssues;
let manifest;

const github = () => calls.filter(call => call.url.includes('api.github.com'));
const opened = () => github().find(call => call.url.endsWith('/issues') && call.method === 'POST');

async function runCron() {
  const waits = [];
  await worker.scheduled({ scheduledTime: NOW }, env, { waitUntil: promise => waits.push(promise) });
  await Promise.all(waits);
}

beforeEach(() => {
  calls = [];
  openIssues = [];
  manifest = null;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    if (url.endsWith('/manifest.json')) {
      return manifest ? new Response(JSON.stringify(manifest)) : new Response('Not found', { status: 404 });
    }
    return new Response(url.includes('state=open') ? JSON.stringify(openIssues) : '{}');
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const publishedAgo = hours => { manifest = { generated_at: new Date(NOW - hours * HOUR).toISOString() }; };

test('cron starts the pipeline and stays quiet while feeds are fresh', async () => {
  publishedAgo(1);
  await runCron();
  assert.deepEqual(github().map(call => call.method), ['POST']);
  assert.match(github()[0].url, /owner\/repo\/actions\/workflows\/publish\.yml\/dispatches$/);
  assert.equal(JSON.parse(github()[0].body).ref, 'main');
});

test('stale feeds open one issue', async () => {
  publishedAgo(5);
  await runCron();
  assert.match(JSON.parse(opened().body).title, /5h old/);
});

test('an open alarm is not repeated', async () => {
  publishedAgo(5);
  openIssues = [{ number: 1 }];
  await runCron();
  assert.equal(opened(), undefined);
});

test('a missing manifest counts as stale', async () => {
  await runCron();
  assert.match(JSON.parse(opened().body).title, /unknown/);
});
