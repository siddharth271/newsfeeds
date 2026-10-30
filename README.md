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

This folder is meant to be its own **public** GitHub repo. Public repos get free Actions
minutes; a private repo would run out of them at this schedule.

1. Copy this folder to a new public repo, with `.github/` at the repo root.
2. In Cloudflare, create an R2 bucket named `litz-feeds`, connect a custom domain for
   public reads, and create an API token that can edit R2.
3. In the GitHub repo settings, add the secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
4. Run the **Publish feeds** workflow by hand and check that the files reach the bucket.
5. Create a GitHub fine-grained token for this repo with **Actions: read and write**.
6. In `worker/wrangler.toml`, set `GITHUB_REPO`. Then, from `worker/`:

   ```
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler deploy
   ```

7. In the app, set `FEED_BASE` in `constants/Config.js` to the bucket's domain.

A failed workflow run emails the repo owner. The app keeps showing the last good feed.
