// Starts the GitHub Actions pipeline on time. Deployed with `wrangler deploy` from this folder.
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/publish.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'litz-cron',
          },
          body: JSON.stringify({ ref: 'main' }),
        }
      ).then(response => {
        if (!response.ok) throw new Error(`GitHub dispatch failed: ${response.status}`);
      })
    );
  },
};
