require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const NEWS_REFRESH_INTERVAL_MS = Number(process.env.NEWS_REFRESH_INTERVAL_MS) || 10_800_000;
const REQUEST_TIMEOUT_MS = 12_000;
const PUBLISHER_PAGE_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 3_000_000;
const MAX_PUBLISHER_PAGE_BYTES = 512_000;
const MAX_PUBLISHER_IMAGE_REQUESTS = 5;
const PUBLISHER_IMAGE_ARTICLE_COUNT = 4;
const ROOT = __dirname;
const API_KEY = process.env.SERPAPI_API_KEY?.trim();
const categories = [
  { id: 'ghana', label: 'Ghana', query: 'Ghana news', country: 'gh' },
  { id: 'world', label: 'World', query: 'international news', country: 'us' },
  { id: 'business', label: 'Business', query: 'business Ghana', country: 'gh' },
  { id: 'sports', label: 'Sports', query: 'sports Ghana football', country: 'gh' },
  { id: 'technology', label: 'Technology', query: 'technology Ghana', country: 'gh' }
];

let cachedNews = null;
let lastFetchAt = 0;
let refreshInProgress = null;
let activePublisherImageRequests = 0;
const publisherImageRequestQueue = [];

function createApiUrl(feed) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_news');
  url.searchParams.set('q', feed.query);
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', feed.country);
  url.searchParams.set('api_key', API_KEY);
  return url;
}

function createSummaryUrl(feed) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('tbm', 'nws');
  url.searchParams.set('q', feed.query);
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', feed.country);
  url.searchParams.set('num', '10');
  url.searchParams.set('api_key', API_KEY);
  return url;
}

function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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

async function fetchSummaries(feed) {
  const response = await fetch(createSummaryUrl(feed), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'PulseNews/1.0' }
  });
  if (!response.ok) {
    throw new Error(`SerpApi summary search returned HTTP ${response.status}.`);
  }

  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('SerpApi summary response exceeded the allowed size.');
  }
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error('SerpApi returned an unreadable summary response.');
  }
  if (typeof result.error === 'string') throw new Error(getProviderError(result, response.status));
  return Array.isArray(result.news_results) ? result.news_results : [];
}

function matchSummaries(articles, summaries) {
  const byUrl = new Map();
  const byTitle = new Map();
  summaries.forEach((item) => {
    const summary = typeof item.snippet === 'string' ? item.snippet.trim() : '';
    if (!summary) return;
    const url = normalizeStoryUrl(item.link);
    const title = normalizeTitle(item.title);
    if (url && !byUrl.has(url)) byUrl.set(url, summary);
    if (title && !byTitle.has(title)) byTitle.set(title, summary);
  });

  return articles.map((article) => {
    const summary = byUrl.get(normalizeStoryUrl(article.url)) ||
      byTitle.get(normalizeTitle(article.title));
    return summary ? { ...article, description: summary.slice(0, 1000) } : article;
  });
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
  return String(value)
    .replaceAll(API_KEY, '[redacted]')
    .replaceAll(encodeURIComponent(API_KEY), '[redacted]');
}

function getProviderError(body, status) {
  const providerMessage = typeof body?.error === 'string' ? body.error : '';
  const safeMessage = redactApiKey(providerMessage);

  if (/invalid api key|api key.*invalid|unauthorized|authentication/i.test(safeMessage) || status === 401) {
    return 'SerpApi rejected the API key. Copy the private API key from your SerpApi dashboard into SERPAPI_API_KEY in .env, then restart the server.';
  }
  if (/limit|quota|too many requests|run out of searches/i.test(safeMessage) || status === 429) {
    return 'SerpApi search limit reached. Check your account quota and plan.';
  }
  if (safeMessage) return `SerpApi error: ${safeMessage.slice(0, 400)}`;
  return `SerpApi returned HTTP ${status}. Check your API key, account quota, and request parameters.`;
}

async function fetchCategory(feed) {
  const response = await fetch(createApiUrl(feed), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'PulseNews/1.0' }
  });
  if (!response.ok) {
    const errorBody = await response.text();
    if (Buffer.byteLength(errorBody, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error(`SerpApi returned HTTP ${response.status} with an oversized error response.`);
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
    throw new Error('SerpApi response exceeded the allowed size.');
  }
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error('SerpApi returned an unreadable response.');
  }

  if (typeof result.error === 'string') {
    throw new Error(getProviderError(result, response.status));
  }
  if (!Array.isArray(result.news_results)) {
    throw new Error('SerpApi response did not contain a news_results list.');
  }
  return result.news_results.map((article) => normalizeArticle({
    title: article.title,
    description: article.snippet || '',
    image: article.thumbnail,
    source: article.source,
    url: article.link,
    publishedAt: article.published_at || article.iso_date || article.date
  }, feed)).filter(Boolean);
}

async function fetchCategoryWithSummaries(feed) {
  const [articles, summaryResults] = await Promise.all([
    fetchCategory(feed),
    fetchSummaries(feed).catch((error) => {
      const message = redactApiKey(error instanceof Error ? error.message : 'Unknown summary search error');
      console.error(`SerpApi summary search failed (${feed.label}): ${message}`);
      return null;
    })
  ]);
  const enrichedArticles = summaryResults ? matchSummaries(articles, summaryResults) : articles;
  return upgradePublisherImages(feed, enrichedArticles);
}

async function refreshNews() {
  if (!API_KEY) {
    throw new Error('SerpApi is not configured. Add SERPAPI_API_KEY=your_key_here to the .env file, then restart the server.');
  }

  const results = await Promise.allSettled(categories.map(fetchCategoryWithSummaries));
  const nextCategories = { ...(cachedNews?.categories || {}) };
  const errors = [];

  results.forEach((result, index) => {
    const feed = categories[index];
    if (result.status === 'fulfilled') {
      nextCategories[feed.id] = {
        updatedAt: new Date().toISOString(),
        articles: result.value
      };
      return;
    }

    const message = redactApiKey(result.reason instanceof Error ? result.reason.message : 'Unknown news API error');
    console.error(`SerpApi request failed (${feed.label}): ${message}`);
    errors.push(`${feed.label}: ${message}`);
  });

  const articles = categories
    .flatMap((feed) => nextCategories[feed.id]?.articles || [])
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  if (!articles.length) {
    throw new Error(errors[0] || 'SerpApi returned no news. Try again later.');
  }

  cachedNews = {
    updatedAt: new Date().toISOString(),
    nextRefreshMs: NEWS_REFRESH_INTERVAL_MS,
    warning: errors.length ? `Some categories could not be refreshed: ${errors.join('; ')}` : '',
    categories: nextCategories,
    articles
  };
  return cachedNews;
}

async function getNews() {
  if (!API_KEY) return refreshNews();
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
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
  console.log(`PulseNews is running at http://${HOST}:${PORT}`);
  console.log(`SerpApi cache interval: ${NEWS_REFRESH_INTERVAL_MS}ms`);
});
