import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleFeeds, impactOf, rank, threadStories } from '../src/curate.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const hoursAgo = hours => new Date(NOW - hours * 3600000).toISOString();
let nextId = 0;

const story = (title, source, over = {}) => {
  nextId += 1;
  return {
    id: `s${nextId}`, url: `https://${source.replace(/\W/g, '')}.test/${nextId}`, title, summary: '', image_url: null,
    source, published_date: hoursAgo(2), category: 'crypto', weight: 1, related: [], ...over,
  };
};

// Real headlines from one day of feeds
const BINANCE = [
  ['Binance Suffers Security Breach Affecting $6.3 Billion in Assets, Nearly $3 Billion Frozen', 'The Hacker News', 'security'],
  ['Binance investigating hack as suspicious outflows reach up to $5.8 billion', 'The Block', 'crypto'],
  ["Binance loses over $6 billion in 'biggest crypto hack in history'", 'CoinDesk', 'crypto'],
  ['Binance hacker splits $1.4 billion of bitcoin into 19 wallets that no one can freeze', 'CoinDesk', 'crypto'],
  ['Binance pauses withdrawals as hackers suspected of stealing billions in crypto', 'TechCrunch', 'industry'],
  ['Binance Drained of $5.5 Billion in Suspected Hack, Tether and Circle Freeze $1.8 Billion', 'Decrypt', 'crypto'],
  ["Crypto's longtime foe, North Korea's Lazarus Group, likely behind Binance hack: blockchain sleuths", 'CoinDesk', 'crypto'],
].map(([title, source, category]) => story(title, source, { category }));

const UNRELATED = [
  ['Rivian’s R2 is officially its best-selling vehicle', 'The Verge'],
  ['Google is giving Gemini’s overlay a literal sparkle on your Android phone', 'Android Authority'],
  ['Google announces Gemini 4 Carbon, its latest frontier AI model', 'Ars Technica'],
  ['Cisco Patches Actively Exploited ASA and FTD VPN Flaw That Can Crash Firewalls', 'The Hacker News'],
  ['Telegram Android Flaw Lets Attackers Run Code When Users Answer Voice Calls', 'The Hacker News'],
  ['Microsoft stock jumps 4% as cloud growth drives earnings and revenue beat', 'CNBC Tech'],
].map(([title, source]) => story(title, source, { category: 'industry' }));

// Rarity only means something against a normal day, when these names are everywhere
const BACKGROUND = Array.from({ length: 40 }, (_, index) =>
  story(`Google Gemini Android Microsoft Cloud Flaw Attackers Code roundup ${index}`, `Outlet ${index}`, { category: 'industry' }));

test('reports of one developing story fold into a single thread', () => {
  const threads = threadStories([...BINANCE, ...UNRELATED, ...BACKGROUND]);
  const binance = threads.filter(thread => /binance/i.test(thread.title));
  assert.equal(binance.length, 1);
  assert.equal(binance[0].updates.length, BINANCE.length - 1);
  assert.equal(threads.length, UNRELATED.length + BACKGROUND.length + 1);
});

test('differently framed reports of one incident still join', () => {
  const threads = threadStories([
    ...BINANCE,
    story('What is EIP-7702? The Ethereum Upgrade Behind the $6.4B Binance Hack', 'Decrypt'),
    story('Hackers steal $6.3 billion from Binance in record crypto heist', 'The Verge'),
    ...BACKGROUND,
  ]);
  assert.equal(threads.filter(thread => thread.updates.length > 0 || /binance/i.test(thread.title)).length, 1);
});

test('a huge story joins up even when its name is no longer rare', () => {
  const coverage = Array.from({ length: 30 }, (_, index) => story(`Binance hack update number ${index} from desk`, `Desk ${index}`));
  const threads = threadStories([...coverage, ...BINANCE, ...BACKGROUND]);
  assert.equal(threads.filter(thread => /binance/i.test(thread.title)).length, 1);
});

test('a name with many unrelated stories keeps them apart', () => {
  const threads = threadStories([
    story('Microsoft outage hits Teams users', 'The Verge'),
    story('Microsoft outage disrupts Azure in Europe', 'The Register'),
    story('Microsoft outage takes Outlook down', 'BleepingComputer'),
    ...Array.from({ length: 10 }, (_, index) => story(`Microsoft ships product ${index} for developers`, `Desk ${index}`)),
    ...BACKGROUND,
  ]);
  assert.ok(threads.filter(thread => /microsoft/i.test(thread.title)).length >= 10);
});

test('a company in two unrelated stories stays two stories', () => {
  const threads = threadStories([
    story('Polymarket halts trading after crypto-draining script breach', 'BleepingComputer'),
    story('Polymarket brings ultra-short prediction markets to U.S. platform', 'CoinDesk'),
    ...BACKGROUND,
  ]);
  assert.equal(threads.filter(thread => /polymarket/i.test(thread.title)).length, 2);
});

test('shared generic words do not join separate stories', () => {
  const corpus = [...UNRELATED, ...BACKGROUND];
  assert.equal(threadStories(corpus).length, corpus.length);
});

test('a thread lists its updates newest first and reaches every category it touches', () => {
  const [thread] = threadStories(BINANCE.map((item, index) => ({ ...item, published_date: hoursAgo(index + 1) })));
  const times = thread.updates.map(update => update.published_date);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.deepEqual([...thread.categories].sort(), ['crypto', 'industry', 'security']);
  assert.equal(thread.updated_at, hoursAgo(1));
});

test('one publisher writing about a theme is not a developing story', () => {
  const series = threadStories([
    story('Binance hack drained wallets backing customer assets', 'CoinDesk'),
    story('Binance hack sends bitcoin tumbling', 'CoinDesk'),
  ]);
  assert.equal(series.length, 2);
});

test('impact rewards scale, coverage and severity', () => {
  const huge = threadStories(BINANCE)[0];
  const small = threadStories([story('Rivian’s R2 is officially its best-selling vehicle', 'The Verge')])[0];
  const exploited = threadStories([story('Cisco Patches Actively Exploited ASA and FTD VPN Flaw', 'BleepingComputer')])[0];
  const score = item => impactOf(item, 0, NOW);
  assert.ok(score(huge) >= 70, `Binance scored ${score(huge)}`);
  assert.ok(score(exploited) > score(small));
  assert.ok(score(huge) > score(exploited));
});

test('the biggest story outranks fresher minor news', () => {
  const minor = story('Rivian’s R2 is officially its best-selling vehicle', 'The Verge', { published_date: hoursAgo(0.5) });
  const ranked = rank(threadStories([...BINANCE.map(item => ({ ...item, published_date: hoursAgo(9) })), minor]), new Map(), NOW);
  assert.match(ranked[0].title, /Binance/);
});

test('updates keep a developing story fresh', () => {
  const quiet = rank(threadStories([story('Acme hack exposes nothing much', 'A', { published_date: hoursAgo(20) })]), new Map(), NOW)[0];
  const developing = rank(threadStories([
    story('Acme hack exposes nothing much', 'A', { published_date: hoursAgo(20) }),
    story('Acme hack exposes nothing much more', 'B', { published_date: hoursAgo(1) }),
  ]), new Map(), NOW)[0];
  assert.ok(developing.score > quiet.score);
  assert.equal(developing.updated_at, hoursAgo(1));
});

test('feeds show a thread once, in each category it touches, with public fields only', () => {
  const feeds = assembleFeeds([...BINANCE, ...UNRELATED], [], NOW);
  for (const category of ['crypto', 'security']) {
    assert.equal(feeds[category].filter(item => /binance/i.test(item.title)).length, 1);
  }
  const lead = feeds.top.find(item => /binance/i.test(item.title));
  for (const field of ['weight', 'thread_sources', 'thread_text', 'thread_published']) assert.equal(field in lead, false);
  assert.ok(lead.impact > 0);
  assert.equal(lead.source_count, 5);
});
