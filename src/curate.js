import { canonicalUrl, hashUrl, jaccard, namedTokens, stem, titleTokens } from './text.js';

const HOUR = 60 * 60 * 1000;

export const CATEGORIES = ['ai', 'cloud', 'security', 'data', 'crypto', 'industry'];

const MAX_AGE_HOURS = 7 * 24;
const CLUSTER_WINDOW_HOURS = 48;
const CLUSTER_THRESHOLD = 0.42;
// Different wording still matches when headlines share enough names and figures
const CLUSTER_LOOSE_THRESHOLD = 0.25;
const CLUSTER_MIN_SHARED_NAMES = 2;
// A thread follows one developing story across several events. Tuned on real feeds: the
// shared words must be rare enough together, and a story must connect to two members,
// because one link lets a thread drift from story to story.
const THREAD_WINDOW_HOURS = 48;
const THREAD_MIN_RARITY = 6.5;
const THREAD_MIN_OVERLAP = 0.25;
const THREAD_MAX_NAME_SHARE = 0.025;
const THREAD_MIN_CORPUS = 500;
const THREAD_MIN_LINKS = 2;
const THREAD_MIN_DENSITY = 0.3;
const THREAD_REPORT_LINKS = 3;
// A name must appear in this share of a group to say what the group is about
const THREAD_ANCHOR_SHARE = 0.4;
// When most of a name's stories mention one incident, they are all about that incident.
// Rarity can't catch this: the bigger the story, the more common its name becomes.
const INCIDENT_MIN_SHARE = 0.5;
const INCIDENT_MIN_STORIES = 3;
const INCIDENT_WORDS = ['hack', 'breach', 'heist', 'outage'];
const MAX_UPDATES = 60;

const TOP_MAX_PER_NAME = 3;
const BASE_HALF_LIFE_HOURS = 10;
// The more a story matters, the longer it stays near the top
const HALF_LIFE_HOURS_PER_IMPACT = 0.3;
const RECENT_HOURS = 6;
const SOURCES_FOR_FULL_COVERAGE = 10;
const REPORTS_FOR_FULL_SPEED = 5;
const MIN_SOURCE_WEIGHT = 0.8;
const MAX_SOURCE_WEIGHT = 1.5;

const IMPACT_WEIGHTS = { scale: 30, coverage: 25, speed: 20, authority: 15, event: 10 };

const SEVERE = /\b(actively exploited|exploited in the wild|zero-day|cvss[^.]{0,20}\b(?:9(?:\.\d)?|10(?:\.0)?))\b/i;
const SUPERLATIVE = /\b(biggest|largest|record|historic|worst|unprecedented)\b/i;
const MONEY = /\$\s?(\d+(?:\.\d+)?)\s?(trillion|billion|bn|million|m)\b/gi;
const PEOPLE = /(\d+(?:\.\d+)?)\s?(billion|million)\s+(?:\w+\s+)?(users|customers|people|accounts|records|devices|employees|workers)\b/gi;
const MAJOR_EVENT = [
  /\b(hack(?:ed)?|breach(?:ed)?|ransomware|data leak|outage|zero-day|actively exploited)\b/i,
  /\b(acquires?|acquisition|merger|to buy|ipo|bankruptcy|layoffs?|lays? off)\b/i,
  /\b(antitrust|indicted|charges|sanctions?|lawsuit|settlement|banned?|fined?)\b/i,
  /\b(releases?|launch(?:es)?|announces?|unveils?)\b.*\b(gpt|claude|gemini|llama|grok|mistral|frontier model)\b/i,
];

// Shopping, how-to-buy and sponsored posts are not news
const NOT_NEWS = [
  /\b(prime day|black friday|cyber monday|coupons?|promo codes?|on sale)\b/i,
  /\b\d+% off\b|\$\d+ off\b|\bsave (?:up to )?\$\d+/i,
  /\bbest\b.*\bdeals?\b|\bdeals?\s*:/i,
  /\b(discounts?|freebies)\b/i,
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
      match.related.push({ source: item.source, title: item.title, url: item.url, published_date: item.published_date });
      match.time = Math.min(match.time, time);
    } else {
      clusters.push({ lead: item, tokens, names, time, sources: new Set([item.source]), related: [] });
    }
  }

  return clusters.map(({ lead, related }) => ({ ...lead, related }));
}

const threadWords = story => new Set([...titleTokens(story.title)].map(stem));
const threadNames = story => new Set([...namedTokens(story.title)].filter(name => /[a-z]/.test(name)).map(stem));

function linkFinder(stories) {
  const counts = new Map();
  for (const story of stories) for (const word of threadWords(story)) counts.set(word, (counts.get(word) ?? 0) + 1);

  const corpus = Math.max(stories.length, THREAD_MIN_CORPUS);
  const nameLimit = corpus * THREAD_MAX_NAME_SHARE;
  const rarity = word => Math.log(corpus / (counts.get(word) ?? 1));

  return (a, b) => {
    if (Math.abs(a.time - b.time) > THREAD_WINDOW_HOURS * HOUR) return false;
    const shared = [...a.words].filter(word => b.words.has(word));
    const sharesName = shared.some(word => a.names.has(word) && b.names.has(word) && counts.get(word) <= nameLimit);
    if (!sharesName) return false;
    const rareEnough = shared.reduce((sum, word) => sum + rarity(word), 0) >= THREAD_MIN_RARITY;
    return rareEnough && shared.length / Math.min(a.words.size, b.words.size) >= THREAD_MIN_OVERLAP;
  };
}

const reportCount = story => story.related.length + 1;

function buildThread([lead, ...others]) {
  const everyone = [lead, ...others];
  return {
    ...lead,
    weight: Math.max(...everyone.map(story => story.weight)),
    categories: [...new Set(everyone.map(story => story.category))],
    updated_at: everyone.map(story => story.published_date).sort().at(-1),
    // Every report in the thread, so the app can show each source the card counts
    updates: others
      .flatMap(story => [story, ...story.related])
      .sort((a, b) => b.published_date.localeCompare(a.published_date))
      .slice(0, MAX_UPDATES)
      .map(({ title, source, url, published_date }) => ({ title, source, url, published_date })),
    thread_sources: [...new Set(everyone.flatMap(story => [story.source, ...story.related.map(report => report.source)]))],
    thread_text: [...everyone.map(story => story.title), lead.summary ?? ''].join(' . '),
    thread_published: everyone.map(story => story.published_date),
  };
}

/** Folds stories about one developing event into its best report, with the rest as updates. */
export function threadStories(stories) {
  const linked = linkFinder(stories);
  const byStrength = [...stories].sort((a, b) =>
    reportCount(b) - reportCount(a) || storyScore(b) - storyScore(a) || b.published_date.localeCompare(a.published_date));

  let threads = [];
  for (const story of byStrength) {
    const member = { story, words: threadWords(story), names: threadNames(story), time: Date.parse(story.published_date) };
    const thread = threads.find(members =>
      members.filter(other => linked(member, other)).length >= Math.min(THREAD_MIN_LINKS, members.length));
    if (thread) thread.push(member);
    else threads.push([member]);
  }

  // Which story arrived first shapes the groups, so join two when many of their members connect.
  // One or two links are not enough here: that is how a thread turns into a whole company.
  const everyMember = threads.flat();
  const incidentOf = new Map();
  for (const name of new Set(everyMember.flatMap(member => [...member.names]))) {
    const named = everyMember.filter(member => member.names.has(name));
    const incident = INCIDENT_WORDS.find(word => {
      const hits = named.filter(member => member.words.has(word)).length;
      return hits >= INCIDENT_MIN_STORIES && hits / named.length >= INCIDENT_MIN_SHARE;
    });
    if (incident) incidentOf.set(name, incident);
  }

  const anchors = members => [...incidentOf.keys()].filter(name =>
    members.filter(member => member.names.has(name)).length / members.length >= THREAD_ANCHOR_SHARE);
  const sameIncident = (a, b) => {
    const named = anchors(b);
    return anchors(a).some(name => named.includes(name));
  };

  const shouldJoin = (a, b) => {
    if (sameIncident(a, b)) return true;
    const pairs = a.flatMap(one => b.filter(other => linked(one, other))).length;
    return pairs >= THREAD_MIN_LINKS && pairs / (a.length * b.length) >= THREAD_MIN_DENSITY;
  };
  let merging = true;
  while (merging) {
    merging = false;
    const joined = [];
    for (const members of threads) {
      const match = joined.find(group => shouldJoin(members, group));
      if (match) {
        match.push(...members);
        merging = true;
      } else {
        joined.push(members);
      }
    }
    threads = joined;
  }

  return threads.flatMap(members => {
    // One publisher's posts on a theme are a series, not a developing story
    if (new Set(members.map(({ story }) => story.source)).size === 1) return members.map(({ story }) => buildThread([story]));

    // The widest-reported headline leads, then the one most connected to the rest
    const leadScore = member => reportCount(member.story) * THREAD_REPORT_LINKS
      + members.filter(other => other !== member && linked(member, other)).length;
    return [buildThread([...members].sort((a, b) => leadScore(b) - leadScore(a)).map(({ story }) => story))];
  });
}

const AMOUNT_SCALE = { trillion: 1e12, billion: 1e9, bn: 1e9, million: 1e6, m: 1e6 };

function largestAmount(text, pattern) {
  return Math.max(0, ...[...text.matchAll(pattern)].map(match => Number(match[1]) * AMOUNT_SCALE[match[2].toLowerCase()]));
}

function scaleOf(text) {
  const money = largestAmount(text, MONEY);
  const people = largestAmount(text, PEOPLE);
  const moneyScale = money >= 1e9 ? 1 : money >= 1e8 ? 0.7 : money >= 1e7 ? 0.4 : 0;
  const peopleScale = people >= 1e8 ? 1 : people >= 1e7 ? 0.7 : people >= 1e6 ? 0.5 : 0;
  const severity = SEVERE.test(text) ? 0.8 : 0;
  return Math.min(1, Math.max(moneyScale, peopleScale, severity) + (SUPERLATIVE.test(text) ? 0.3 : 0));
}

/** How much a story matters, from 0 to 100, regardless of how old it is. */
export function impactOf(story, buzz, now) {
  const sources = story.thread_sources?.length ?? story.related.length + 1;
  const recent = (story.thread_published ?? [story.published_date])
    .filter(date => (now - Date.parse(date)) / HOUR <= RECENT_HOURS).length;
  const text = story.thread_text ?? story.title;

  const parts = {
    scale: scaleOf(text),
    coverage: Math.min(1, Math.log2(sources) / Math.log2(SOURCES_FOR_FULL_COVERAGE)),
    speed: Math.min(1, (recent + buzz) / REPORTS_FOR_FULL_SPEED),
    authority: Math.min(1, Math.max(0, (story.weight - MIN_SOURCE_WEIGHT) / (MAX_SOURCE_WEIGHT - MIN_SOURCE_WEIGHT))),
    event: MAJOR_EVENT.some(pattern => pattern.test(text)) ? 1 : 0,
  };
  return Math.round(Object.entries(IMPACT_WEIGHTS).reduce((sum, [part, weight]) => sum + parts[part] * weight, 0));
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
      const updatedAt = story.updated_at ?? story.published_date;
      const ageHours = (now - Date.parse(updatedAt)) / HOUR;
      const impact = impactOf(story, signals.get(story.url) ?? 0, now);
      const freshness = 0.5 ** (ageHours / (BASE_HALF_LIFE_HOURS + impact * HALF_LIFE_HOURS_PER_IMPACT));
      const score = (0.1 + impact / 100) * freshness;
      const { weight, thread_sources, thread_text, thread_published, ...rest } = story;
      return {
        ...rest,
        categories: story.categories ?? [story.category],
        updates: story.updates ?? [],
        updated_at: updatedAt,
        impact,
        score: Number(score.toFixed(4)),
        source_count: thread_sources?.length ?? story.related.length + 1,
      };
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
  const ranked = rank(threadStories(clusterStories(unique)), signals, now);

  const feeds = {};
  for (const category of CATEGORIES) {
    feeds[category] = capPerSource(ranked.filter(story => story.categories.includes(category)), perCategory);
  }
  feeds.top = capPerSource(capPerName(ranked, ranked.length), topCount, 0.15);
  return feeds;
}
