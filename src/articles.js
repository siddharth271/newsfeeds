import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripHtml, titleTokens } from './text.js';

const MAX_LOOKUPS_PER_RUN = 100;
const CONCURRENCY = 8;
const TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 700 * 1024;
const FULL_SUMMARY_WORDS = 45;
const SUMMARY_WORDS = 70;
const MIN_PARAGRAPH_LENGTH = 60;
const MIN_TITLE_WORDS_FOUND = 2;

const NOT_ARTICLE = /<(script|style|nav|header|footer|aside|form|figure)\b[\s\S]*?<\/\1>/gi;
const NOT_PROSE = /\b(subscribe|sign up|newsletter|cookies?|all rights reserved|advertisement|follow us|read more|click here|log in|your inbox|terms of (use|service)|privacy policy)\b/i;

const words = text => text.trim().split(/\s+/).filter(Boolean);

function clip(text) {
  const all = words(text);
  if (all.length <= SUMMARY_WORDS) return text;
  const clipped = all.slice(0, SUMMARY_WORDS).join(' ');
  const end = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('? '), clipped.lastIndexOf('! '));
  return end > clipped.length / 3 ? clipped.slice(0, end + 1) : `${clipped}...`;
}

/** The opening of an article in the publisher's own words. Nothing is generated. */
export function extractSummary(html, title) {
  const page = html.replace(NOT_ARTICLE, ' ');
  const body = page.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? page;

  const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(match => stripHtml(match[1]))
    .filter(text => text.length >= MIN_PARAGRAPH_LENGTH && !NOT_PROSE.test(text));

  const chosen = [];
  let count = 0;
  for (const paragraph of paragraphs) {
    chosen.push(paragraph);
    count += words(paragraph).length;
    if (count >= SUMMARY_WORDS) break;
  }
  const text = chosen.join(' ');

  // A paywall or error page won't talk about the story
  const lower = text.toLowerCase();
  const found = [...titleTokens(title)].filter(word => lower.includes(word)).length;
  return found >= MIN_TITLE_WORDS_FOUND ? clip(text) : '';
}

async function readPage(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let bytes = 0;
  while (bytes < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    html += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return html;
}

async function lookup(story, userAgent) {
  try {
    const response = await fetch(story.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': userAgent, Accept: 'text/html' },
    });
    if (!response.ok || !response.body) return '';
    return extractSummary(await readPage(response), story.title);
  } catch {
    return '';
  }
}

/**
 * Lengthens thin feed excerpts, most important stories first. Results, including misses,
 * are cached so publishers aren't re-crawled every run.
 */
export async function enrichSummaries(stories, cachePath, userAgent) {
  let cache = {};
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf8'));
  } catch {
    // First run, or the cache was evicted
  }

  const thin = [...stories]
    .sort((a, b) => b.score - a.score)
    .filter(story => words(story.summary ?? '').length < FULL_SUMMARY_WORDS);
  const pending = thin.filter(story => !(story.id in cache));
  const queue = pending.slice(0, MAX_LOOKUPS_PER_RUN);

  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < queue.length) {
        const story = queue[next];
        next += 1;
        cache[story.id] = await lookup(story, userAgent);
      }
    })
  );

  let improved = 0;
  for (const story of thin) {
    const found = cache[story.id];
    if (found && words(found).length > words(story.summary ?? '').length) {
      story.summary = found;
      improved += 1;
    }
  }

  const live = new Set(stories.map(story => story.id));
  const pruned = Object.fromEntries(Object.entries(cache).filter(([id]) => live.has(id)));
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(pruned));

  return { looked_up: queue.length, improved };
}
