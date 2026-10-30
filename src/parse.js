import { XMLParser } from 'fast-xml-parser';
import { cleanExcerpt, decodeEntities, stripHtml } from './text.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: false,
  processEntities: false,
  htmlEntities: false,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

const toArray = value => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return String(value['#text'] ?? '');
  return String(value);
}

function atomLink(links) {
  const all = toArray(links);
  const alternate = all.find(link => typeof link === 'object' && (!link['@_rel'] || link['@_rel'] === 'alternate'));
  const chosen = alternate ?? all[0];
  return typeof chosen === 'object' ? chosen['@_href'] ?? text(chosen) : text(chosen);
}

function isImageUrl(url) {
  return /^https:\/\//.test(url) && !/\.(svg|gif)(\?|$)/i.test(url) && !/(pixel|tracker|1x1|spacer|gravatar|feedburner)/i.test(url);
}

function findImage(item, bodies) {
  const candidates = [];

  for (const media of toArray(item['media:content'])) {
    const medium = media?.['@_medium'] ?? '';
    const type = media?.['@_type'] ?? '';
    if (!medium || medium === 'image' || type.startsWith('image/')) candidates.push(media?.['@_url']);
  }
  for (const group of toArray(item['media:group'])) {
    for (const media of toArray(group?.['media:content'])) candidates.push(media?.['@_url']);
  }
  for (const thumb of toArray(item['media:thumbnail'])) candidates.push(thumb?.['@_url']);
  for (const enclosure of toArray(item.enclosure)) {
    if (String(enclosure?.['@_type'] ?? '').startsWith('image/')) candidates.push(enclosure?.['@_url']);
  }
  for (const body of bodies) {
    const match = decodeEntities(String(body)).match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) candidates.push(match[1].replace(/&amp;/g, '&'));
  }

  return candidates.find(url => url && isImageUrl(url)) ?? null;
}

function toIso(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function fromRss(item) {
  const title = stripHtml(text(item.title));
  const description = text(item.description);
  const encoded = text(item['content:encoded']);
  return {
    title,
    url: text(item.link).trim() || (item.guid?.['@_isPermaLink'] !== 'false' ? text(item.guid).trim() : ''),
    excerpt: cleanExcerpt(description || encoded, title),
    image: findImage(item, [encoded, description]),
    publishedAt: toIso(text(item.pubDate) || text(item['dc:date'])),
  };
}

function fromAtom(entry) {
  const title = stripHtml(text(entry.title));
  const summary = text(entry.summary);
  const content = text(entry.content);
  return {
    title,
    url: atomLink(entry.link),
    excerpt: cleanExcerpt(summary || content, title),
    image: findImage(entry, [content, summary]),
    publishedAt: toIso(text(entry.published) || text(entry.updated)),
  };
}

export function parseFeed(xml) {
  const doc = parser.parse(xml);
  if (doc.rss?.channel) return toArray(doc.rss.channel.item).map(fromRss);
  if (doc['rdf:RDF']) return toArray(doc['rdf:RDF'].item).map(fromRss);
  if (doc.feed) return toArray(doc.feed.entry).map(fromAtom);
  throw new Error('Not an RSS or Atom document');
}
