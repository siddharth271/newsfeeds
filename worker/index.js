// Serves the feeds from R2, starts the GitHub Actions pipeline on time, and raises the
// alarm if publishing stops. Deployed with `wrangler deploy` from this folder.
const FEED_PATH = /^\/static\/([a-z]+\.json)$/;
const EDGE_CACHE_SECONDS = 60;
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const STALE_LABEL = 'stale-feed';

function github(env, path, options = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'litz-feeds',
    },
  });
}

async function startPipeline(env) {
  const response = await github(env, '/actions/workflows/publish.yml/dispatches', {
    method: 'POST',
    body: JSON.stringify({ ref: 'main' }),
  });
  if (!response.ok) throw new Error(`GitHub dispatch failed: ${response.status}`);
}

/** Opens one GitHub issue when feeds go stale, which emails the repo owner. */
async function checkFreshness(env, now) {
  const manifest = await env.FEEDS.get('manifest.json');
  const generatedAt = manifest ? Date.parse((await manifest.json()).generated_at) : 0;
  if (now - generatedAt < STALE_AFTER_MS) return false;

  const open = await github(env, `/issues?labels=${STALE_LABEL}&state=open`);
  if (!open.ok) throw new Error(`GitHub issue lookup failed: ${open.status}`);
  if ((await open.json()).length > 0) return true;

  const hours = generatedAt ? Math.floor((now - generatedAt) / 3600000) : 'unknown';
  const created = await github(env, '/issues', {
    method: 'POST',
    body: JSON.stringify({
      title: `Litz feeds are stale (${hours}h old)`,
      body: 'The app is showing old news. Check the latest Publish feeds run. Close this issue once feeds are fresh.',
      labels: [STALE_LABEL],
    }),
  });
  if (!created.ok) throw new Error(`GitHub issue creation failed: ${created.status}`);
  return true;
}

async function serveFeed(request, env, ctx) {
  const url = new URL(request.url);
  const match = url.pathname.match(FEED_PATH);
  if (!match || request.method !== 'GET') return new Response('Not found', { status: 404 });

  // The app adds ?t= to bypass device caches, so the edge cache ignores the query
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const object = await env.FEEDS.get(match[1]);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', `public, max-age=${EDGE_CACHE_SECONDS}`);
  const response = new Response(object.body, { headers });
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

export default {
  fetch: serveFeed,

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([startPipeline(env), checkFreshness(env, event.scheduledTime)]));
  },
};
