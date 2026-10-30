import { canonicalUrl, hashUrl, jaccard, namedTokens, titleTokens } from './text.js';

const HOUR = 60 * 60 * 1000;

export const CATEGORIES = ['ai', 'cloud', 'security', 'data', 'crypto', 'industry'];

const MAX_AGE_HOURS = 7 * 24;
const CLUSTER_WINDOW_HOURS = 48;
const CLUSTER_THRESHOLD = 0.42;
// Different wording still matches when headlines share enough names and figures
const CLUSTER_LOOSE_THRESHOLD = 0.25;
const CLUSTER_MIN_SHARED_NAMES = 2;
const TOP_MAX_PER_NAME = 3;
const FRESHNESS_HALF_LIFE_HOURS = 14;

// Shopping, how-to-buy and sponsored posts are not news
const NOT_NEWS = [
  /\b(prime day|black friday|cyber monday|coupons?|promo codes?|on sale)\b/i,
  /\b\d+% off\b|\$\d+ off\b|\bsave (?:up to )?\$\d+/i,
  /\bbest\b.*\bdeals?\b|\bdeals?\s*:/i,
  /\b(best|top \d+) .*\b(to buy|you can buy|right now|of 20\d\d|for 20\d\d)\b/i,
  /\b(sponsored|advertorial|partner content|webinar|horoscope|wordle|connections hint)\b/i,
  /\b(review|hands-on)\s*:/i,
];

const KEYWORD_ROUTES = [
  ['security', /\b(breach|hack(?:ed|ers?)?|ransomware|malware|zero-day|vulnerabilit\w+|cve-\d+|phishing|exploit\w*|cyber\w*)\b/i],
  ['crypto', /\b(bitcoin|ethereum|crypto\w*|stablecoin|blockchain|solana|defi)\b/i],
  ['ai', /\b(ai|a\.i\.|llm|gpt|chatgpt|openai|anthropic|claude|gemini|deepmind|llama|mistral|copilot|machine learning|neural|agentic|nvidia)\b/i],
  ['cloud', /\b(aws|azure|kubernetes|docker|devops|serverless|terraform|open source|linux|github)\b/i],
  ['data', /\b(data warehouse|snowflake|databricks|postgres\w*|database|etl)\b/i],
];

export function isNews(title) {
  return !NOT_NEWS.some(pattern => pattern.test(title));
}

export function routeCategory(source, title) {
  if (!source.classify) return source.category;
  const hit = KEYWORD_ROUTES.find(([, pattern]) => pattern.test(title));
  return hit ? hit[0] : source.category;
}

export function normalize(rawItems, source, now) {
  const items = [];
  for (const raw of rawItems) {
    const url = canonicalUrl(raw.url);
    if (!url || !raw.title || !raw.publishedAt) continue;

    const published = Date.parse(raw.publishedAt);
    const ageHours = (now - published) / HOUR;
    if (ageHours > MAX_AGE_HOURS || ageHours < -1) continue;
    if (!isNews(raw.title)) continue;

    items.push({
      id: hashUrl(url),
      url,
      title: raw.title,
      summary: raw.excerpt,
      image_url: raw.image,
      source: source.name,
      published_date: new Date(Math.min(published, now)).toISOString(),
      category: routeCategory(source, raw.title),
      weight: source.weight ?? 1,
    });
  }
  return items;
}

// The richest report leads the cluster; timestamps only break ties
function storyScore(item) {
  return item.weight * (item.summary ? 1 : 0.8) * (item.image_url ? 1 : 0.9);
}

function isSameEvent(cluster, tokens, names) {
  const overlap = jaccard(cluster.tokens, tokens);
  if (overlap >= CLUSTER_THRESHOLD) return true;
  if (overlap < CLUSTER_LOOSE_THRESHOLD) return false;
  let shared = 0;
  for (const name of names) if (cluster.names.has(name)) shared += 1;
  return shared >= CLUSTER_MIN_SHARED_NAMES;
}

/** Merges reports of one event: greedy matching on headline overlap within a time window. */
export function clusterStories(items) {
  const sorted = [...items].sort((a, b) => storyScore(b) - storyScore(a) || b.published_date.localeCompare(a.published_date));
  const clusters = [];

  for (const item of sorted) {
    const tokens = titleTokens(item.title);
    const names = namedTokens(item.title);
    const time = Date.parse(item.published_date);
    const match = clusters.find(cluster =>
      cluster.lead.source !== item.source &&
      !cluster.sources.has(item.source) &&
      Math.abs(cluster.time - time) <= CLUSTER_WINDOW_HOURS * HOUR &&
      isSameEvent(cluster, tokens, names)
    );

    if (match) {
      match.sources.add(item.source);
      match.related.push({ source: item.source, title: item.title, url: item.url });
      match.time = Math.min(match.time, time);
    } else {
      clusters.push({ lead: item, tokens, names, time, sources: new Set([item.source]), related: [] });
    }
  }

  return clusters.map(({ lead, related }) => ({ ...lead, related }));
}

export function buildSignalIndex(signalItems) {
  const urls = new Map();
  for (const item of signalItems) {
    const url = canonicalUrl(item.url);
    if (url) urls.set(url, (urls.get(url) ?? 0) + 1);
  }
  return urls;
}

export function rank(stories, signals, now) {
  return stories
    .map(story => {
      const ageHours = (now - Date.parse(story.published_date)) / HOUR;
      const freshness = 0.5 ** (ageHours / FRESHNESS_HALF_LIFE_HOURS);
      const coverage = 1 + Math.log2(1 + story.related.length);
      const buzz = 1 + 0.5 * (signals.get(story.url) ?? 0);
      const score = freshness * story.weight * coverage * buzz;
      const { weight, ...rest } = story;
      return { ...rest, score: Number(score.toFixed(4)), source_count: story.related.length + 1 };
    })
    .sort((a, b) => b.score - a.score);
}

/** Keeps the feed from turning into one prolific publisher. */
export function capPerSource(stories, limit, maxShare = 0.2) {
  const maxPerSource = Math.max(3, Math.ceil(limit * maxShare));
  const counts = new Map();
  const kept = [];
  for (const story of stories) {
    const count = counts.get(story.source) ?? 0;
    if (count >= maxPerSource) continue;
    counts.set(story.source, count + 1);
    kept.push(story);
    if (kept.length === limit) break;
  }
  return kept;
}

/** Stops one big event or company taking over the Top feed. */
export function capPerName(stories, limit) {
  const counts = new Map();
  const kept = [];
  for (const story of stories) {
    const names = [...namedTokens(story.title)].filter(name => /[a-z]/.test(name));
    if (names.some(name => (counts.get(name) ?? 0) >= TOP_MAX_PER_NAME)) continue;
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    kept.push(story);
    if (kept.length === limit) break;
  }
  return kept;
}

export function assembleFeeds(items, signalItems, now, { perCategory = 150, topCount = 40 } = {}) {
  const signals = buildSignalIndex(signalItems);
  const unique = [...new Map(items.map(item => [item.id, item])).values()];
  const ranked = rank(clusterStories(unique), signals, now);

  const feeds = {};
  for (const category of CATEGORIES) {
    feeds[category] = capPerSource(ranked.filter(story => story.category === category), perCategory);
  }
  feeds.top = capPerSource(capPerName(ranked, ranked.length), topCount, 0.15);
  return feeds;
}
