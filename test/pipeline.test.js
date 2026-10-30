import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../src/parse.js';
import { canonicalUrl, cleanExcerpt, decodeEntities, namedTokens, stripHtml } from '../src/text.js';
import { extractOgImage } from '../src/images.js';
import { assembleFeeds, capPerName, capPerSource, clusterStories, isNews, normalize, rank, routeCategory } from '../src/curate.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const hoursAgo = hours => new Date(NOW - hours * 3600000).toISOString();

const story = (over = {}) => ({
  id: over.url ?? 'x',
  url: 'https://a.test/1',
  title: 'Some headline',
  summary: 'A summary that is present.',
  image_url: 'https://a.test/i.jpg',
  source: 'A',
  published_date: hoursAgo(1),
  category: 'ai',
  weight: 1,
  ...over,
});

test('parses RSS with CDATA, media image and date', () => {
  const [item] = parseFeed(`<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item>
    <title><![CDATA[Rust &amp; Go]]></title><link>https://a.test/post?utm_source=x</link>
    <description><![CDATA[<p>A long enough description of what actually happened in this story.</p>]]></description>
    <media:content url="https://a.test/img.jpg" medium="image"/><pubDate>Fri, 30 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`);
  assert.equal(item.title, 'Rust & Go');
  assert.equal(item.url, 'https://a.test/post?utm_source=x');
  assert.equal(item.image, 'https://a.test/img.jpg');
  assert.equal(item.publishedAt, '2026-10-30T10:00:00.000Z');
  assert.match(item.excerpt, /^A long enough/);
});

test('parses Atom, preferring the alternate link and first inline image', () => {
  const [item] = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Hello</title>
    <link rel="self" href="https://a.test/self"/><link rel="alternate" href="https://a.test/post"/>
    <published>2026-10-30T09:00:00Z</published>
    <content type="html">&lt;img src="https://a.test/pic.png"&gt;&lt;p&gt;Body text that is long enough to be kept as an excerpt.&lt;/p&gt;</content></entry></feed>`);
  assert.equal(item.url, 'https://a.test/post');
  assert.equal(item.image, 'https://a.test/pic.png');
  assert.match(item.excerpt, /^Body text/);
});

test('rejects documents that are not feeds', () => {
  assert.throws(() => parseFeed('<html><body>nope</body></html>'), /Not an RSS/);
});

test('decodes entities, including double-encoded HTML', () => {
  assert.equal(decodeEntities('it&#8217;s &amp; &#x41;'), 'it’s & A');
  assert.equal(stripHtml('&lt;b&gt;bold&lt;/b&gt; text'), 'bold text');
});

test('excerpts lose boilerplate and stop on a sentence', () => {
  assert.equal(cleanExcerpt('<p>Short.</p>'), '');
  const noisy = 'This is a real sentence about the news of the day. The post Thing appeared first on Site.';
  assert.equal(cleanExcerpt(noisy), 'This is a real sentence about the news of the day.');
  const long = `${'Word '.repeat(20).trim()}. ${'More '.repeat(100)}`;
  assert.ok(cleanExcerpt(long).endsWith('.'));
  assert.ok(cleanExcerpt(long).length <= 320);
});

test('canonical URLs drop tracking and rejects non-web schemes', () => {
  assert.equal(canonicalUrl('http://www.a.test/x/?utm_source=y&id=2#top'), 'https://a.test/x?id=2');
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  assert.equal(canonicalUrl('not a url'), null);
});

test('filters shopping posts but keeps real news', () => {
  assert.equal(isNews('Best laptops to buy right now'), false);
  assert.equal(isNews('Save $200 on this phone in the Prime sale'), false);
  assert.equal(isNews('Google signs $2 billion chip deal'), true);
  assert.equal(isNews('OpenAI ships a new reasoning model'), true);
});

test('routes generic outlets by headline and leaves specialists alone', () => {
  const generic = { category: 'industry', classify: true };
  assert.equal(routeCategory(generic, 'Ransomware hits a hospital chain'), 'security');
  assert.equal(routeCategory(generic, 'Apple updates the iPad'), 'industry');
  assert.equal(routeCategory({ category: 'cloud' }, 'Ransomware hits a hospital chain'), 'cloud');
});

test('normalize drops stale, future and undated items instead of faking a date', () => {
  const source = { name: 'A', category: 'ai', weight: 1 };
  const base = { title: 'Fresh story', url: 'https://a.test/1', excerpt: '', image: null };
  const items = normalize([
    { ...base, publishedAt: hoursAgo(2) },
    { ...base, url: 'https://a.test/2', publishedAt: hoursAgo(24 * 30) },
    { ...base, url: 'https://a.test/3', publishedAt: hoursAgo(-5) },
    { ...base, url: 'https://a.test/4', publishedAt: null },
  ], source, NOW);
  assert.deepEqual(items.map(item => item.url), ['https://a.test/1']);
});

test('clusters coverage of one event and keeps unrelated stories apart', () => {
  const clustered = clusterStories([
    story({ url: 'https://a.test/1', source: 'A', weight: 1.5, title: 'OpenAI releases GPT-6 model with reasoning upgrades' }),
    story({ url: 'https://b.test/1', source: 'B', title: 'OpenAI releases GPT-6 model, reasoning upgrades included' }),
    story({ url: 'https://c.test/1', source: 'C', title: 'Kubernetes 1.40 graduates sidecar containers' }),
  ]);
  assert.equal(clustered.length, 2);
  const lead = clustered.find(item => item.source === 'A');
  assert.deepEqual(lead.related.map(item => item.source), ['B']);
});

test('one publisher never clusters with itself', () => {
  const clustered = clusterStories([
    story({ url: 'https://a.test/1', title: 'Bitcoin price update for Tuesday markets' }),
    story({ url: 'https://a.test/2', title: 'Bitcoin price update for Wednesday markets' }),
  ]);
  assert.equal(clustered.length, 2);
});

test('ranking rewards freshness and coverage, and hides the internal weight', () => {
  const ranked = rank([
    { ...story({ url: 'https://old.test', published_date: hoursAgo(48) }), related: [] },
    { ...story({ url: 'https://new.test' }), related: [] },
    { ...story({ url: 'https://big.test' }), related: [{}, {}, {}] },
  ], new Map(), NOW);
  assert.deepEqual(ranked.map(item => item.url), ['https://big.test', 'https://new.test', 'https://old.test']);
  assert.equal(ranked[0].source_count, 4);
  assert.equal('weight' in ranked[0], false);
});

test('source cap stops one publisher filling the feed', () => {
  const stories = Array.from({ length: 50 }, (_, index) => story({ url: `https://a.test/${index}` }));
  assert.equal(capPerSource(stories, 20).length, 4);
});

test('assembleFeeds fills every category plus top', () => {
  const feeds = assembleFeeds([story({ id: '1' }), story({ id: '1' }), story({ id: '2', url: 'https://b.test/2', source: 'B', title: 'Other story entirely different', category: 'cloud' })], [], NOW);
  assert.equal(feeds.ai.length, 1);
  assert.equal(feeds.cloud.length, 1);
  assert.equal(feeds.top.length, 2);
  assert.equal(feeds.crypto.length, 0);
});

test('differently worded reports cluster on shared names and figures', () => {
  const clustered = clusterStories([
    story({ url: 'https://a.test/1', source: 'A', weight: 2, title: 'Binance probes potential $5.8 billion crypto-theft hack' }),
    story({ url: 'https://b.test/1', source: 'B', title: 'Binance suspected $5.8 billion hack, funds frozen' }),
    story({ url: 'https://c.test/1', source: 'C', title: 'Binance adds a new trading pair for users' }),
  ]);
  assert.equal(clustered.length, 2);
});

test('namedTokens finds names and figures, not sentence-case first words', () => {
  assert.deepEqual([...namedTokens('Massive leak hits OpenAI and $5.8 billion Binance')], ['openai', '$5.8', 'binance']);
});

test('capPerName limits how much one name fills Top', () => {
  const stories = Array.from({ length: 6 }, (_, index) => story({ url: `https://a.test/${index}`, title: `Story about Binance number ${index}` }));
  assert.equal(capPerName(stories, 6).length, 3);
});

test('extractOgImage handles either attribute order and rejects http', () => {
  assert.equal(extractOgImage('<meta property="og:image" content="https://a.test/i.jpg">'), 'https://a.test/i.jpg');
  assert.equal(extractOgImage('<meta content="https://a.test/j.jpg" name="twitter:image">'), 'https://a.test/j.jpg');
  assert.equal(extractOgImage('<meta property="og:image" content="http://a.test/i.jpg">'), null);
});

test('shared generic words never merge unrelated stories', () => {
  const clustered = clusterStories([
    story({ url: 'https://a.test/1', source: 'A', title: 'Fake crypto app on Apple App Store linked to wallet theft' }),
    story({ url: 'https://b.test/1', source: 'B', title: 'Apple cuts App Store commission in Taiwan' }),
    story({ url: 'https://c.test/1', source: 'C', title: 'What took the Internet offline in Q3 2026' }),
    story({ url: 'https://d.test/1', source: 'D', title: 'Alphabet reports Q3 2026 revenue of $127 billion' }),
  ]);
  assert.equal(clustered.length, 4);
});
