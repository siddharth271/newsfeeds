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
Public repos get free Actions minutes; a private repo would run out of them at this
schedule. The Cloudflare Worker in `worker/` serves the feeds, so no domain is needed.

1. Create the R2 bucket: `npx wrangler r2 bucket create litz-feeds`.
2. Create a Cloudflare API token with **Workers R2 Storage: Edit**.
3. In the GitHub repo settings, add the secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
4. Run the **Publish feeds** workflow by hand and check that the files reach the bucket.
5. Create a GitHub fine-grained token for this repo with **Actions: read and write** and
   **Issues: read and write**.
6. From `worker/`:

   ```
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN
   ```

7. In the app, set `FEED_BASE` in `constants/Config.js` to the Worker's
   `https://litz-feeds.<account>.workers.dev/static` address.

A failed workflow run emails the repo owner. If feeds are over two hours old for any
reason, the Worker opens a `stale-feed` GitHub issue, which also emails the owner. The app
keeps showing the last good feed.
