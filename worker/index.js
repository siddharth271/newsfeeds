// Starts the GitHub Actions pipeline on time and raises the alarm if publishing stops.
// Deployed with `wrangler deploy` from this folder.
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

async function lastPublished(env) {
  const response = await fetch(`${env.FEED_BASE}/manifest.json`, { cf: { cacheTtl: 0 } });
  if (!response.ok) return 0;
  return Date.parse((await response.json()).generated_at) || 0;
}

/** Opens one GitHub issue when feeds go stale, which emails the repo owner. */
async function checkFreshness(env, now) {
  const generatedAt = await lastPublished(env);
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([startPipeline(env), checkFreshness(env, event.scheduledTime)]));
  },
};
