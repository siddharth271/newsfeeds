import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSummary } from '../src/articles.js';
import { keyPoints, mergeEpisodes, parseShow } from '../src/podcasts.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const prose = 'Binance confirmed the hack on Thursday and paused all withdrawals while investigators traced the stolen funds across several chains.';

test('summaries come from the article and skip page furniture', () => {
  const html = `<html><nav><p>Home News Subscribe to our daily newsletter for all the updates now</p></nav>
    <article><p>${prose}</p><p>Sign up for our newsletter to get this story and many others.</p>
    <p>Second paragraph about the Binance hack with enough words to count as real article prose here.</p></article></html>`;
  const summary = extractSummary(html, 'Binance hack shakes crypto markets');
  assert.ok(summary.startsWith('Binance confirmed'));
  assert.ok(!/newsletter/i.test(summary));
  assert.match(summary, /Second paragraph/);
});

test('long summaries stop at a sentence', () => {
  const long = Array.from({ length: 12 }, () => prose).join(' ');
  const summary = extractSummary(`<p>${long}</p>`, 'Binance hack withdrawals');
  assert.ok(summary.split(/\s+/).length <= 70);
  assert.ok(summary.endsWith('.'));
});

test('a page that is not about the story gives nothing', () => {
  const paywall = '<p>You have reached your limit of free articles this month on this website.</p>';
  assert.equal(extractSummary(paywall, 'Binance hack shakes crypto markets'), '');
});

const FEED = `<?xml version="1.0"?><rss xmlns:itunes="x" xmlns:content="y"><channel><title>Show</title>
  <itunes:image href="https://img.test/a.jpg"/>
  <item><title>Episode one with Jane</title><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate>
    <enclosure url="https://cdn.test/one.mp3" type="audio/mpeg"/><itunes:duration>1:30:00</itunes:duration>
    <content:encoded><![CDATA[<p>Watch: <a href="https://www.youtube.com/watch?v=abcdefghijk">video</a></p>
    <ul><li>(00:12:30) Why agents still fail at long tasks</li><li>Sponsored by a great company today</li>
    <li>How inference costs fell during the last year</li></ul>]]></content:encoded></item>
  <item><title>Old episode</title><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate><enclosure url="https://cdn.test/old.mp3"/></item>
  <item><title>No audio</title><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

test('parses recent episodes with their YouTube link and duration', () => {
  const episodes = parseShow(FEED, { name: 'Show', topic: 'AI' }, NOW);
  assert.equal(episodes.length, 1);
  const [episode] = episodes;
  assert.equal(episode.youtube_id, 'abcdefghijk');
  assert.equal(episode.minutes, 90);
  assert.equal(episode.artwork, 'https://img.test/a.jpg');
});

test('key points keep timestamps and drop promotion', () => {
  const points = keyPoints('<ul><li>(00:12:30) Why agents still fail at long tasks</li><li>Sponsored by a great company today</li><li>How inference costs fell last year</li></ul>');
  assert.deepEqual(points, [
    { text: 'Why agents still fail at long tasks', at: 750 },
    { text: 'How inference costs fell last year' },
  ]);
});

test('episodes merge newest first', () => {
  const merged = mergeEpisodes([
    [{ published_date: '2026-10-01T00:00:00.000Z', id: 'old' }],
    [{ published_date: '2026-10-20T00:00:00.000Z', id: 'new' }],
  ]);
  assert.deepEqual(merged.map(item => item.id), ['new', 'old']);
});
