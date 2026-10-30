import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseFeed } from './parse.js';
import { assembleFeeds, normalize, CATEGORIES } from './curate.js';
import { enrichImages } from './images.js';
import { enrichSummaries } from './articles.js';
import { mergeEpisodes, parseShow } from './podcasts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(process.env.OUT_DIR ?? path.join(ROOT, 'dist'));
const CACHE_DIR = path.resolve(process.env.CACHE_DIR ?? path.join(ROOT, '.cache'));
const IMAGE_CACHE = path.join(CACHE_DIR, 'images.json');
const SUMMARY_CACHE = path.join(CACHE_DIR, 'summaries.json');
const USER_AGENT = 'LitzBot/1.0';
const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 12;
// Below this we keep the last good feed rather than publish a thin one
const MIN_HEALTHY_SHARE = 0.6;
const MIN_STORIES = 60;

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchSource(source) {
  const started = Date.now();
  try {
    const items = parseFeed(await fetchWithRetry(source.url));
    return { source, items, ms: Date.now() - started };
  } catch (error) {
    return { source, items: [], error: error.message, ms: Date.now() - started };
  }
}

async function fetchAll(sources) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < sources.length) {
        const source = sources[next];
        next += 1;
        results.push(await fetchSource(source));
      }
    })
  );
  return results;
}

async function fetchPodcasts(now) {
  const shows = JSON.parse(await readFile(path.join(ROOT, 'podcasts.json'), 'utf8'));
  const results = await Promise.all(shows.map(async show => {
    try {
      return parseShow(await fetchWithRetry(show.url), show, now);
    } catch (error) {
      console.error(`Podcast ${show.name} failed: ${error.message}`);
      return [];
    }
  }));
  return mergeEpisodes(results);
}

async function writeOutput(feeds, manifest) {
  const tmpDir = `${OUT_DIR}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  for (const [name, stories] of Object.entries(feeds)) {
    await writeFile(path.join(tmpDir, `${name}.json`), JSON.stringify(stories));
  }
  await writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Swap in one step so a crash can never leave a half-written feed
  await rm(OUT_DIR, { recursive: true, force: true });
  await rename(tmpDir, OUT_DIR);
}

async function main() {
  const sources = JSON.parse(await readFile(path.join(ROOT, 'sources.json'), 'utf8'));
  const now = Date.now();
  const results = await fetchAll(sources);

  const failed = results.filter(result => result.error);
  const healthyShare = (results.length - failed.length) / results.length;

  const items = results
    .filter(result => result.source.role !== 'signal')
    .flatMap(result => normalize(result.items, result.source, now));
  const signalItems = results
    .filter(result => result.source.role === 'signal')
    .flatMap(result => result.items);

  const feeds = assembleFeeds(items, signalItems, now);
  const everyStory = [...new Map(Object.values(feeds).flat().map(story => [story.id, story])).values()];
  const images = await enrichImages(everyStory, IMAGE_CACHE, USER_AGENT);
  const summaries = await enrichSummaries(everyStory, SUMMARY_CACHE, USER_AGENT);
  for (const list of Object.values(feeds)) {
    for (const story of list) {
      const enriched = everyStory.find(item => item.id === story.id);
      story.image_url = enriched.image_url;
      story.summary = enriched.summary;
    }
  }
  feeds.podcasts = await fetchPodcasts(now);

  const total = CATEGORIES.reduce((sum, category) => sum + feeds[category].length, 0);

  const manifest = {
    generated_at: new Date(now).toISOString(),
    stories: total,
    sources_ok: results.length - failed.length,
    sources_total: results.length,
    images,
    summaries,
    counts: Object.fromEntries(Object.entries(feeds).map(([name, list]) => [name, list.length])),
    failed: failed.map(result => ({ source: result.source.name, error: result.error })),
  };

  console.log(JSON.stringify({ ...manifest, failed: failed.map(f => f.source.name) }, null, 2));

  if (healthyShare < MIN_HEALTHY_SHARE || total < MIN_STORIES) {
    console.error(`Refusing to publish: ${Math.round(healthyShare * 100)}% of sources healthy, ${total} stories`);
    process.exitCode = 1;
    return;
  }

  await writeOutput(feeds, manifest);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
