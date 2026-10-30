import { XMLParser } from 'fast-xml-parser';
import { hashUrl, stripHtml } from './text.js';

const MAX_AGE_DAYS = 30;
const MAX_PER_SHOW = 4;
const MAX_EPISODES = 60;
const MAX_POINTS = 5;
const MIN_POINT_LENGTH = 25;
const MIN_POINT_WORDS = 5;
const MAX_POINT_LENGTH = 180;
const DAY = 24 * 60 * 60 * 1000;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false });

const PROMOTION = /\b(sponsor|sponsored|brought to you|promo code|discount|subscribe|patreon|merch|follow (us|me)|newsletter|sign up|join us|our website|transcript|presented by|free trial|% off)\b/i;
const YOUTUBE = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^"'\s<]*v=|youtu\.be\/)([\w-]{11})/i;
const TIMESTAMP = /^[([]?(\d{1,2}(?::\d{2}){1,2})[)\]]?\s*[-–—:]?\s*/;

const asList = value => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const text = value => (typeof value === 'object' && value !== null ? value['#text'] ?? '' : value ?? '');

function seconds(stamp) {
  return stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function durationMinutes(value) {
  const raw = String(text(value)).trim();
  if (!raw) return null;
  const total = raw.includes(':') ? seconds(raw) : Number(raw);
  return Number.isFinite(total) && total > 0 ? Math.round(total / 60) : null;
}

/** The host's own bullet points, with timestamps kept so a reader can jump in. */
export function keyPoints(notes) {
  const items = [...notes.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(match => stripHtml(match[1]));
  // Without a list, read the prose up to the point it turns into sponsor reads
  const prose = stripHtml(notes.replace(/<\/p>|<br\s*\/?>/gi, '\n')).split(/\bsponsors?\b/i)[0];
  const lines = items.length > 0 ? items : prose.split(/(?<=[.!?])\s+/);

  const points = [];
  for (const line of lines) {
    const stamp = line.match(TIMESTAMP);
    const body = (stamp ? line.slice(stamp[0].length) : line).trim();
    if (body.length < MIN_POINT_LENGTH || body.length > MAX_POINT_LENGTH) continue;
    if (body.split(/\s+/).length < MIN_POINT_WORDS) continue;
    if (PROMOTION.test(body) || /https?:\/\//.test(body)) continue;
    points.push(stamp ? { text: body, at: seconds(stamp[1]) } : { text: body });
    if (points.length === MAX_POINTS) break;
  }
  return points;
}

export function parseShow(xml, show, now) {
  const channel = parser.parse(xml)?.rss?.channel;
  if (!channel) throw new Error('Not a podcast feed');

  const artwork = channel['itunes:image']?.['@_href'] ?? null;
  return asList(channel.item)
    .map(item => {
      const published = Date.parse(text(item.pubDate));
      const audio = item.enclosure?.['@_url'];
      const title = stripHtml(String(text(item.title)));
      if (!title || !audio || Number.isNaN(published) || now - published > MAX_AGE_DAYS * DAY) return null;

      const notes = String(text(item['content:encoded']) || text(item.description) || text(item['itunes:summary']));
      const youtube = notes.match(YOUTUBE)?.[1];
      const link = typeof item.link === 'string' ? item.link : null;
      return {
        id: hashUrl(audio),
        title,
        show: show.name,
        topic: show.topic,
        artwork,
        published_date: new Date(published).toISOString(),
        minutes: durationMinutes(item['itunes:duration']),
        audio_url: audio,
        link,
        youtube_id: youtube ?? null,
        summary: stripHtml(notes).slice(0, 320),
        points: keyPoints(notes),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_PER_SHOW);
}

/** Newest episodes across every show. One failing feed never stops the others. */
export function mergeEpisodes(shows) {
  return shows.flat()
    .sort((a, b) => b.published_date.localeCompare(a.published_date))
    .slice(0, MAX_EPISODES);
}
