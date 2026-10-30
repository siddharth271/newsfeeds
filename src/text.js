import { createHash } from 'node:crypto';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-',
  hellip: '...', copy: '(c)', reg: '(R)', trade: '(TM)',
};

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(
    decodeEntities(String(html))
      .replace(/<(script|style|figure|figcaption)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// Feed boilerplate that adds nothing to a reader
const BOILERPLATE = [
  /\bThe post .{0,200}? appeared first on .{0,100}$/i,
  /\bThis article (?:originally )?appeared (?:first )?(?:on|in) .{0,100}$/i,
  /\bContinue reading.{0,100}$/i,
  /\bRead (?:the )?(?:full|more|rest).{0,80}$/i,
  /\bSubscribe (?:now|to).{0,120}$/i,
  /\[(?:\.\.\.|…)\]\s*$/,
  /(?:\.\.\.|…)\s*$/,
  /\s+more\s*$/,
];

export function cleanExcerpt(html, title = '', maxLength = 320) {
  let text = stripHtml(html);
  for (const pattern of BOILERPLATE) text = text.replace(pattern, '').trim();

  // Some feeds repeat the headline as the opening of the description
  if (title && text.toLowerCase().startsWith(title.toLowerCase())) {
    text = text.slice(title.length).replace(/^[\s:.\-|]+/, '');
  }
  if (text.length < 40) return '';
  if (text.length <= maxLength) return text;

  const clipped = text.slice(0, maxLength);
  const sentenceEnd = Math.max(
    clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? ')
  );
  if (sentenceEnd >= maxLength * 0.5) return clipped.slice(0, sentenceEnd + 1);
  return `${clipped.slice(0, clipped.lastIndexOf(' '))}...`;
}

const TRACKING_PARAMS = /^(utm_|mc_|fbclid$|gclid$|ref$|source$|cmp$|cid$|at_medium$|at_campaign$)/i;

export function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    parsed.protocol = 'https:';
    parsed.hash = '';
    parsed.hostname = parsed.hostname.replace(/^www\./, '');
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return null;
  }
}

export function hashUrl(url) {
  return createHash('md5').update(url).digest('hex');
}

const STOP_WORDS = new Set(`a about after all also an and any are as at be been but by can could did do does
for from had has have he her his how i if in into is it its just like may more most new no not now of on one
or our out over say says said she so some than that the their them then there these they this to too up us
behind against before under while through between back off down still get gets make makes takes first last
was we were what when where which who why will with would you your amid via vs`.split(/\s+/));

export function titleTokens(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .replace(/[^a-z0-9$%.\s-]/g, ' ')
      .split(/\s+/)
      .map(word => word.replace(/^[.-]+|[.-]+$/g, ''))
      .filter(word => word.length > 1 && !STOP_WORDS.has(word))
  );
}

/** Crude, but enough for headlines to treat hack, hacker and hackers as one word. */
export function stem(word) {
  return word.replace(/(ers?|ing|ed|s)$/, '') || word;
}

// Capitalised or numeric in headlines, but they say nothing about which event it is
const GENERIC_NAMES = new Set(`ai app apps store stores model models agent agents startup startups massive report reports
study update updates weekly roundup introducing announcing how us uk eu security data cloud news tech hackers
q1 q2 q3 q4 january february march april may june july august september october november december
monday tuesday wednesday thursday friday saturday sunday`.split(/\s+/));

const isYear = word => /^20\d\d$/.test(word);

/** Names and figures from a headline: the words most likely to identify one event. */
export function namedTokens(title) {
  const names = new Set();
  for (const word of title.replace(/['’]s\b/g, '').split(/\s+/)) {
    const clean = word.replace(/^[^A-Za-z0-9$]+|[^A-Za-z0-9%]+$/g, '');
    const lower = clean.toLowerCase();
    if (!clean || STOP_WORDS.has(lower) || GENERIC_NAMES.has(lower) || isYear(lower)) continue;
    if (/^\$?\d/.test(clean) || /^[A-Z]/.test(clean)) names.add(lower);
  }
  return names;
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}
