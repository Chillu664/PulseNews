require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const NEWS_REFRESH_INTERVAL_MS = Number(process.env.NEWS_REFRESH_INTERVAL_MS) || 900_000;
const DEFAULT_FRONTEND_ORIGINS = [
  'null',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];
const FRONTEND_ORIGINS = new Set(
  (process.env.FRONTEND_ORIGINS
    ? process.env.FRONTEND_ORIGINS.split(',')
    : DEFAULT_FRONTEND_ORIGINS)
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const REQUEST_TIMEOUT_MS = 12_000;
const PUBLISHER_PAGE_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 3_000_000;
const MAX_PUBLISHER_PAGE_BYTES = 512_000;
const MAX_PUBLISHER_IMAGE_REQUESTS = 5;
const PUBLISHER_IMAGE_ARTICLE_COUNT = 4;
const ROOT = __dirname;
const USE_GNEWS = process.env.NEWS_PROVIDER?.trim().toLowerCase() === 'gnews';
const API_KEY = [
  process.env.GNEWS_API_KEY,
  process.env.GNews_API_KEY,
  process.env.gnews_api_key,
  process.env.Gnews_api_key
].find((value) => typeof value === 'string' && value.trim())?.trim();
const categories = [
  { id: 'ghana', label: 'Ghana', query: 'Ghana news', rssQuery: 'Ghana news', country: 'gh' },
  { id: 'world', label: 'World', query: 'international news', rssQuery: 'world news' },
  { id: 'business', label: 'Business', query: 'business Ghana', rssQuery: 'Ghana business', country: 'gh' },
  { id: 'sports', label: 'Sports', query: 'sports Ghana football', rssQuery: 'Ghana sports', country: 'gh' },
  { id: 'technology', label: 'Technology', query: 'technology Ghana', rssQuery: 'Ghana technology', country: 'gh' }
];

let cachedNews = null;
let lastFetchAt = 0;
let refreshInProgress = null;
let activePublisherImageRequests = 0;
const publisherImageRequestQueue = [];

function createApiUrl(feed) {
  const url = new URL('https://gnews.io/api/v4/search');
  url.searchParams.set('q', feed.query);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('max', '10');
  url.searchParams.set('sortby', 'publishedAt');
  if (feed.country) url.searchParams.set('country', feed.country);
  url.searchParams.set('apikey', API_KEY);
  return url;
}

function createRssUrl(feed) {
  const countryCode = feed.country === 'gh' ? 'GH' : 'US';
  const language = feed.country === 'gh' ? 'en-GH' : 'en';
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', feed.rssQuery);
  url.searchParams.set('hl', language);
  url.searchParams.set('gl', countryCode);
  url.searchParams.set('ceid', `${countryCode}:${language.split('-')[0]}`);
  return url;
}

function extractRssTag(item, tagName) {
  const match = item.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'i'));
  if (!match) return '';
  return decodeHtmlAttribute(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').trim());
}

function parseRssArticles(xml, feed) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].slice(0, 10);
  return items.map((match) => {
    const item = match[1];
    const url = extractRssTag(item, 'link');
    const title = extractRssTag(item, 'title');
    const publishedAt = extractRssTag(item, 'pubDate');
    const source = extractRssTag(item, 'source');
    return normalizeArticle({
      title,
      description: '',
      image: null,
      source: source || (() => {
        try {
          return new URL(url).hostname.replace(/^www\./, '');
        } catch {
          return 'News source';
        }
      })(),
      url,
      publishedAt
    }, feed);
  }).filter(Boolean);
}

async function fetchRssCategory(feed) {
  const response = await fetch(createRssUrl(feed), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'PulseNews/1.0' }
  });
  if (!response.ok) throw new Error(`Google News RSS returned HTTP ${response.status}`);

  const xml = await response.text();
  if (Buffer.byteLength(xml, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Google News RSS response exceeded the allowed size.');
  }
  const articles = parseRssArticles(xml, feed);
  if (!articles.length) throw new Error('Google News RSS returned no usable articles.');
  return articles;
}

async function fetchCategoryWithFallback(feed) {
  if (USE_GNEWS && API_KEY) {
    try {
      const articles = await fetchCategoryWithImages(feed);
      if (!articles.length) throw new Error('GNews returned no articles.');
      return { articles, provider: 'GNews' };
    } catch (error) {
      const message = redactApiKey(error instanceof Error ? error.message : 'Unknown GNews error');
      console.warn(`GNews request failed (${feed.label}); falling back to Google News RSS: ${message}`);
    }
  }
  return { articles: await fetchRssCategory(feed), provider: 'Google News RSS' };
}

function normalizeStoryUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.hash = '';
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.hostname.replace(/^www\./, '')}${pathname}${url.search}`.toLowerCase();
  } catch {
    return '';
  }
}

function safePublisherUrl(value, base) {
  try {
    const url = new URL(value, base);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password ||
      isIP(hostname) || hostname === 'localhost' ||
      hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function getMetaAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);?/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);?/g, (_, code) => String.fromCodePoint(Number(code)));
}

function findPublisherImage(html, pageUrl) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = getMetaAttributes(match[0]);
    const property = (attributes.get('property') || attributes.get('name') || '').toLowerCase();
    if (!['og:image', 'og:image:secure_url', 'twitter:image'].includes(property)) continue;
    const content = attributes.get('content');
    if (!content) continue;
    const imageUrl = safePublisherUrl(decodeHtmlAttribute(content), pageUrl);
    if (imageUrl) return imageUrl.href;
  }
  return null;
}

async function acquirePublisherImageSlot() {
  if (activePublisherImageRequests >= MAX_PUBLISHER_IMAGE_REQUESTS) {
    await new Promise((resolve) => publisherImageRequestQueue.push(resolve));
  } else {
    activePublisherImageRequests += 1;
  }
}

function releasePublisherImageSlot() {
  const waitingRequest = publisherImageRequestQueue.shift();
  if (waitingRequest) {
    waitingRequest();
  } else {
    activePublisherImageRequests -= 1;
  }
}

async function readPublisherPage(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_PUBLISHER_PAGE_BYTES) {
    throw new Error('publisher page exceeded the allowed size');
  }
  if (!response.body) throw new Error('publisher page had no response body');

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_PUBLISHER_PAGE_BYTES) {
      await reader.cancel();
      throw new Error('publisher page exceeded the allowed size');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

async function fetchPublisherImage(article) {
  const articleUrl = safePublisherUrl(article.url);
  if (!articleUrl) return { error: 'article URL is not a safe HTTPS address' };

  await acquirePublisherImageSlot();
  try {
    const response = await fetch(articleUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PUBLISHER_PAGE_TIMEOUT_MS),
      headers: {
        Accept: 'text/html',
        'User-Agent': 'PulseNews/1.0'
      }
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { error: `publisher page returned HTTP ${response.status}` };
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
      await response.body?.cancel();
      return { error: 'publisher page did not return HTML' };
    }

    const html = await readPublisherPage(response);
    const image = findPublisherImage(html, articleUrl);
    return image ? { image } : { error: 'publisher page did not provide a usable original image' };
  } finally {
    releasePublisherImageSlot();
  }
}

async function upgradePublisherImages(feed, articles) {
  const selected = articles.slice(0, PUBLISHER_IMAGE_ARTICLE_COUNT);
  const results = await Promise.all(selected.map(async (article) => {
    try {
      return { article, ...(await fetchPublisherImage(article)) };
    } catch (error) {
      return {
        article,
        error: error instanceof Error ? error.message : 'unknown publisher image error'
      };
    }
  }));

  const upgraded = new Map();
  const failures = [];
  results.forEach(({ article, image, error }) => {
    if (image && image !== article.image) {
      upgraded.set(article.id, { ...article, image, fallbackImage: article.image });
    } else if (error) {
      failures.push(error);
    }
  });
  if (failures.length) {
    const examples = [...new Set(failures)].slice(0, 2).join('; ');
    console.warn(`Publisher image upgrade incomplete (${feed.label}): ${failures.length}/${selected.length} images; ${examples}.`);
  }
  return articles.map((article) => upgraded.get(article.id) || article);
}

function normalizeArticle(article, feed) {
  if (!article || typeof article.title !== 'string' || typeof article.url !== 'string') return null;

  let link;
  try {
    const url = new URL(article.url);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    link = url.href;
  } catch {
    return null;
  }

  let image = null;
  if (typeof article.image === 'string') {
    try {
      const imageUrl = new URL(article.image);
      if (imageUrl.protocol === 'https:') image = imageUrl.href;
    } catch {
      image = null;
    }
  }

  const publishedDate = article.publishedAt ? new Date(article.publishedAt) : null;
  return {
    id: link,
    title: article.title.slice(0, 400),
    description: typeof article.description === 'string' ? article.description.slice(0, 1000) : '',
    image,
    source: typeof article.source === 'string'
      ? article.source.slice(0, 120)
      : typeof article.source?.name === 'string'
        ? article.source.name.slice(0, 120)
        : 'News source',
    url: link,
    publishedAt: publishedDate && !Number.isNaN(publishedDate.getTime())
      ? publishedDate.toISOString()
      : null,
    category: feed.id,
    categoryLabel: feed.label
  };
}

function redactApiKey(value) {
  if (!API_KEY) return String(value);
  return String(value)
    .replaceAll(API_KEY, '[redacted]')
    .replaceAll(encodeURIComponent(API_KEY), '[redacted]');
}

function getProviderError(body, status) {
  const providerMessage = typeof body?.error === 'string'
    ? body.error
    : Array.isArray(body?.errors)
      ? body.errors.filter((error) => typeof error === 'string').join('; ')
      : '';
  const safeMessage = redactApiKey(providerMessage);

  if (/invalid api key|api key.*invalid|unauthorized|authentication/i.test(safeMessage) ||
    status === 401 || status === 403) {
    return 'GNews rejected the API key. Add a valid GNews API key as GNEWS_API_KEY in .env or your hosting environment, then restart or redeploy the server.';
  }
  if (/limit|quota|too many requests|run out of searches/i.test(safeMessage) || status === 429) {
    return 'GNews request limit reached. Check your GNews account quota and plan.';
  }
  if (safeMessage) return `GNews error: ${safeMessage.slice(0, 400)}`;
  return `GNews returned HTTP ${status}. Check your API key, account quota, and request parameters.`;
}

async function fetchCategory(feed) {
  const response = await fetch(createApiUrl(feed), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'PulseNews/1.0' }
  });
  if (!response.ok) {
    const errorBody = await response.text();
    if (Buffer.byteLength(errorBody, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error(`GNews returned HTTP ${response.status} with an oversized error response.`);
    }
    let parsedError;
    try {
      parsedError = JSON.parse(errorBody);
    } catch {
      parsedError = null;
    }
    throw new Error(getProviderError(parsedError, response.status));
  }

  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('GNews response exceeded the allowed size.');
  }
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error('GNews returned an unreadable response.');
  }

  if (result.status === 'error' || typeof result.error === 'string' || Array.isArray(result.errors)) {
    throw new Error(getProviderError(result, response.status));
  }
  if (!Array.isArray(result.articles)) {
    throw new Error('GNews response did not contain an articles list.');
  }
  return result.articles.map((article) => normalizeArticle({
    title: article.title,
    description: article.description || '',
    image: article.image,
    source: article.source,
    url: article.url,
    publishedAt: article.publishedAt
  }, feed)).filter(Boolean);
}

async function fetchCategoryWithImages(feed) {
  const articles = await fetchCategory(feed);
  return upgradePublisherImages(feed, articles);
}

async function refreshNews() {
  const results = await Promise.allSettled(categories.map(fetchCategoryWithFallback));
  const nextCategories = { ...(cachedNews?.categories || {}) };
  const errors = [];
  const categoryErrors = {};
  const providers = new Set();

  results.forEach((result, index) => {
    const feed = categories[index];
    if (result.status === 'fulfilled') {
      nextCategories[feed.id] = {
        updatedAt: new Date().toISOString(),
        provider: result.value.provider,
        articles: result.value.articles
      };
      providers.add(result.value.provider);
      return;
    }

    const message = redactApiKey(result.reason instanceof Error ? result.reason.message : 'Unknown news feed error');
    console.error(`News request failed (${feed.label}): ${message}`);
    categoryErrors[feed.id] = message;
    errors.push(`${feed.label}: ${message}`);
  });

  categories.forEach((feed) => {
    if (nextCategories[feed.id]?.provider) providers.add(nextCategories[feed.id].provider);
  });
  const articles = categories
    .flatMap((feed) => nextCategories[feed.id]?.articles || [])
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  if (!articles.length) {
    throw new Error(errors[0] || 'News feeds returned no news. Try again later.');
  }

  cachedNews = {
    updatedAt: new Date().toISOString(),
    nextRefreshMs: NEWS_REFRESH_INTERVAL_MS,
    provider: [...providers].join(' + ') || 'News feeds',
    warning: errors.length ? `Some categories could not be refreshed: ${errors.join('; ')}` : '',
    categoryErrors,
    categories: nextCategories,
    articles
  };
  return cachedNews;
}

async function getNews() {
  if (cachedNews && Date.now() - lastFetchAt < NEWS_REFRESH_INTERVAL_MS) return cachedNews;
  if (refreshInProgress) return refreshInProgress;

  lastFetchAt = Date.now();
  refreshInProgress = refreshNews()
    .catch((error) => {
      lastFetchAt = Date.now() - NEWS_REFRESH_INTERVAL_MS + 60_000;
      if (cachedNews?.articles.length) {
        return {
          ...cachedNews,
          warning: `${error.message} Showing the last successful update.`
        };
      }
      throw error;
    })
    .finally(() => {
      refreshInProgress = null;
    });
  return refreshInProgress;
}

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/config.js', ['config.js', 'text/javascript; charset=utf-8']],
  ['/script.js', ['script.js', 'text/javascript; charset=utf-8']]
]);

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function applyApiCors(request, response) {
  const origin = request.headers.origin;
  response.setHeader('Vary', 'Origin');
  if (typeof origin === 'string' && FRONTEND_ORIGINS.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  if (url.pathname === '/api/news') {
    applyApiCors(request, response);
    if (request.method === 'OPTIONS') {
      if (request.headers.origin && !FRONTEND_ORIGINS.has(request.headers.origin)) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.writeHead(204, { Allow: 'GET, OPTIONS' });
      response.end();
      return;
    }
  }

  if (url.pathname === '/healthz' && request.method === 'GET') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    response.end('Method not allowed');
    return;
  }

  if (url.pathname === '/api/news') {
    const categoryId = url.searchParams.get('category');
    if (categoryId && !categories.some((feed) => feed.id === categoryId)) {
      sendJson(response, 400, { error: 'Unknown news category.' });
      return;
    }
    try {
      const news = await getNews();
      if (categoryId) {
        sendJson(response, 200, {
          ...news,
          articles: news.categories[categoryId]?.articles || []
        });
        return;
      }
      sendJson(response, 200, news);
    } catch (error) {
      console.error(`News request failed: ${error.message}`);
      sendJson(response, 503, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  const file = publicFiles.get(url.pathname);
  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  fs.readFile(path.join(ROOT, file[0]), (error, content) => {
    if (error) {
      console.error(`Could not read ${file[0]}: ${error.message}`);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('The requested page could not be loaded.');
      return;
    }
    response.writeHead(200, {
      'Content-Type': file[1],
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(content);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`PulseNews is listening on ${HOST}:${PORT}`);
  console.log(`News feed cache interval: ${NEWS_REFRESH_INTERVAL_MS}ms`);
});
