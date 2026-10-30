# Litz news pipeline

Fetches tech news feeds, keeps publishers' original headlines, groups coverage of the
same event, ranks stories, and writes the JSON files the Litz app reads. It needs no AI,
no API keys and no server of its own.

## Run it locally

```
npm ci
npm test
npm run build
```

Feeds appear in `dist/`. `manifest.json` lists the run time, story counts and any feeds
that failed. If too few sources respond, the run exits with an error and leaves the
previous `dist/` untouched.

## Change the sources

Edit `sources.json`. Each entry has a `name`, `url`, `category` and `weight` (higher ranks
more strongly). `classify: true` routes a general outlet's stories to a topic by headline.
`role: "signal"` feeds never appear in the app; they only boost stories they link to.

## Automate it for free

This folder is published as its own **public** GitHub repo, `siddharth271/newsfeeds`.
Public repos get free Actions minutes and free GitHub Pages hosting, with no payment
setup. Feeds are served from `https://siddharth271.github.io/newsfeeds/static`.

1. In the repo, open **Settings > Pages** and set **Source** to **GitHub Actions**.
2. Run the **Publish feeds** workflow, or wait for its schedule.

That is enough to publish every 15 minutes. GitHub can start scheduled runs late, so the
optional Worker in `worker/` starts them on time and watches for stale feeds:

1. Create a GitHub fine-grained token for this repo with **Actions: read and write** and
   **Issues: read and write**.
2. From `worker/`, with `CLOUDFLARE_ACCOUNT_ID` set:

   ```
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN
   ```

A failed workflow run emails the repo owner. If feeds are over two hours old for any
reason, the Worker opens a `stale-feed` GitHub issue, which also emails the owner. The app
keeps showing the last good feed.
