import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeEntities } from './text.js';

const MAX_LOOKUPS_PER_RUN = 150;
const CONCURRENCY = 8;
const TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 256 * 1024;

const OG_PATTERNS = [
  /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["']/i,
];

export function extractOgImage(html) {
  for (const pattern of OG_PATTERNS) {
    const match = html.match(pattern);
    if (match) {
      const url = decodeEntities(match[1]).trim();
      if (url.startsWith('https://')) return url;
    }
  }
  return null;
}

async function readHead(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let bytes = 0;
  while (bytes < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    html += decoder.decode(value, { stream: true });
    if (html.includes('</head>')) break;
  }
  await reader.cancel().catch(() => {});
  return html;
}

async function lookup(url, userAgent) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': userAgent, Accept: 'text/html' },
    });
    if (!response.ok || !response.body) return null;
    return extractOgImage(await readHead(response));
  } catch {
    return null;
  }
}

/**
 * Fills in images the feed didn't carry from each page's og:image. Results,
 * including misses, are cached so publishers aren't re-crawled every run.
 */
export async function enrichImages(stories, cachePath, userAgent) {
  let cache = {};
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf8'));
  } catch {
    // First run, or the cache was evicted
  }

  const pending = [];
  for (const story of stories) {
    if (story.image_url) continue;
    if (story.id in cache) story.image_url = cache[story.id];
    else pending.push(story);
  }

  const queue = pending.slice(0, MAX_LOOKUPS_PER_RUN);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < queue.length) {
        const story = queue[next];
        next += 1;
        story.image_url = await lookup(story.url, userAgent);
        cache[story.id] = story.image_url;
      }
    })
  );

  const live = new Set(stories.map(story => story.id));
  const pruned = Object.fromEntries(Object.entries(cache).filter(([id]) => live.has(id)));
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(pruned));

  return { looked_up: queue.length, found: queue.filter(story => story.image_url).length };
}
