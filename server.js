require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

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
const MAX_RESPONSE_BYTES = 3_000_000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'app-data.json');
const SESSION_COOKIE = 'pn_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const scrypt = promisify(crypto.scrypt);
const USE_GNEWS = process.env.NEWS_PROVIDER?.trim().toLowerCase() === 'gnews';
const API_KEY = [
  process.env.GNEWS_API_KEY,
  process.env.GNews_API_KEY,
  process.env.gnews_api_key,
  process.env.Gnews_api_key
].find((value) => typeof value === 'string' && value.trim())?.trim();
const categories = [
  { id: 'ghana', label: 'Ghana', query: 'Ghana news', rssQuery: 'Ghana news', country: 'gh' },
  { id: 'world', label: 'World', query: 'international news', rssQuery: 'world news', bingQuery: 'global news' },
  { id: 'business', label: 'Business', query: 'business Ghana', rssQuery: 'Ghana business', country: 'gh' },
  { id: 'sports', label: 'Sports', query: 'sports Ghana football', rssQuery: 'Ghana sports', country: 'gh' },
  { id: 'technology', label: 'Technology', query: 'technology Ghana', rssQuery: 'Ghana technology', country: 'gh' }
];

let cachedNews = null;
let lastFetchAt = 0;
let refreshInProgress = null;
let appData = { users: [], sessions: [], supportMessages: [] };
let saveAppDataInProgress = Promise.resolve();
let appDataLoaded = false;
let appDataLoading = null;

async function loadAppData() {
  if (appDataLoaded) return;
  if (!appDataLoading) {
    appDataLoading = (async () => {
      try {
        const savedData = JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8'));
        appData = {
          users: Array.isArray(savedData.users) ? savedData.users : [],
          sessions: Array.isArray(savedData.sessions) ? savedData.sessions : [],
          supportMessages: Array.isArray(savedData.supportMessages) ? savedData.supportMessages : []
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
      }
      appDataLoaded = true;
    })().catch((error) => {
      appDataLoading = null;
      throw error;
    });
  }
  await appDataLoading;
}

function saveAppData() {
  const snapshot = JSON.stringify(appData);
  saveAppDataInProgress = saveAppDataInProgress.then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryFile, snapshot, { mode: 0o600 });
    await fs.promises.rename(temporaryFile, DATA_FILE);
  });
  return saveAppDataInProgress;
}

function getRequestIp(request) {
  return request.socket.remoteAddress || 'unknown';
}

function setSessionCookie(response, request, token) {
  const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';
  response.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(response, request) {
  response.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
}

function getSessionToken(request) {
  const cookie = request.headers.cookie || '';
  const match = cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? match.slice(SESSION_COOKIE.length + 1) : '';
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function findSessionUser(request) {
  const token = getSessionToken(request);
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = appData.sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > Date.now());
  return session ? appData.users.find((user) => user.id === session.userId) || null : null;
}

async function createSession(response, request, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  appData.sessions = appData.sessions.filter((session) => session.expiresAt > Date.now());
  appData.sessions.push({
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    userId: user.id,
    expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
  });
  await saveAppData();
  setSessionCookie(response, request, token);
}

async function readJsonBody(request, maxBytes = 10_000) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > maxBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Request body must be a JSON object.');
    }
    return body;
  } catch {
    const error = new Error('Request body must be a valid JSON object.');
    error.statusCode = 400;
    throw error;
  }
}

async function handleAuthRequest(request, response, pathname) {
  await loadAppData();
  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = findSessionUser(request);
    sendJson(response, 200, { user: user ? publicUser(user) : null });
    return true;
  }
  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = getSessionToken(request);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    appData.sessions = appData.sessions.filter((session) => session.tokenHash !== tokenHash);
    await saveAppData();
    clearSessionCookie(response, request);
    sendJson(response, 200, { user: null });
    return true;
  }
  if (!['/api/auth/signup', '/api/auth/login'].includes(pathname) || request.method !== 'POST') return false;

  const body = await readJsonBody(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    sendJson(response, 400, { error: 'Enter a valid email address.' });
    return true;
  }
  if (pathname.endsWith('/signup')) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) {
      sendJson(response, 400, { error: 'Name must be between 1 and 80 characters.' });
      return true;
    }
    if (password.length < 8 || password.length > 128) {
      sendJson(response, 400, { error: 'Password must be between 8 and 128 characters.' });
      return true;
    }
    if (appData.users.some((user) => user.email === email)) {
      sendJson(response, 409, { error: 'An account with that email already exists. Please sign in.' });
      return true;
    }
    const salt = crypto.randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);
    if (appData.users.some((existingUser) => existingUser.email === email)) {
      sendJson(response, 409, { error: 'An account with that email already exists. Please sign in.' });
      return true;
    }
    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordSalt: salt.toString('hex'),
      passwordHash: passwordHash.toString('hex'),
      createdAt: new Date().toISOString()
    };
    appData.users.push(user);
    await createSession(response, request, user);
    sendJson(response, 201, { user: publicUser(user) });
    return true;
  }

  const user = appData.users.find((item) => item.email === email);
  const salt = user ? Buffer.from(user.passwordSalt, 'hex') : Buffer.alloc(16);
  const expectedHash = user ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64);
  const passwordHash = await scrypt(password, salt, 64);
  if (!user || passwordHash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(passwordHash, expectedHash)) {
    sendJson(response, 401, { error: 'Email or password is incorrect.' });
    return true;
  }
  await createSession(response, request, user);
  sendJson(response, 200, { user: publicUser(user) });
  return true;
}

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

function createBingRssUrl(feed) {
  const url = new URL('https://www.bing.com/news/search');
  url.searchParams.set('q', feed.bingQuery || feed.rssQuery);
  url.searchParams.set('format', 'rss');
  return url;
}

function extractRssTag(item, tagName) {
  const match = item.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'i'));
  if (!match) return '';
  return decodeHtmlAttribute(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').trim());
}

function extractRssAttribute(item, tagName, attributeName) {
  const tag = item.match(new RegExp(`<${tagName}\\b([^>]*)>`, 'i'));
  if (!tag) return '';
  const attribute = tag[1].match(new RegExp(`\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return attribute ? decodeHtmlAttribute(attribute[1] ?? attribute[2] ?? attribute[3] ?? '') : '';
}

function extractDescriptionImage(item) {
  const description = item.match(/<description\b[^>]*>([\s\S]*?)<\/description\s*>/i)?.[1] || '';
  const unwrappedDescription = description.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const image = unwrappedDescription.match(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  return decodeHtmlAttribute(image?.[1] ?? image?.[2] ?? image?.[3] ?? '');
}

function parseRssArticles(xml, feed) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].slice(0, 12);
  return items.map((match) => {
    const item = match[1];
    let url = unwrapBingNewsUrl(extractRssTag(item, 'link'));
    try {
      const articleUrl = new URL(url);
      if (articleUrl.protocol === 'http:' && articleUrl.hostname === 'www.bing.com') {
        articleUrl.protocol = 'https:';
        url = articleUrl.href;
      }
    } catch {
      url = '';
    }
    const title = extractRssTag(item, 'title');
    const publishedAt = extractRssTag(item, 'pubDate');
    const source = extractRssTag(item, 'source') || extractRssTag(item, 'News:Source');
    const rssDescription = extractRssTag(item, 'description');
    const description = /<a\b[^>]*\bhref\s*=/i.test(rssDescription)
      ? ''
      : rssDescription.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const image = extractRssTag(item, 'News:Image') ||
      extractRssAttribute(item, 'media:content', 'url') ||
      extractRssAttribute(item, 'media:thumbnail', 'url') ||
      extractRssAttribute(item, 'enclosure', 'url') ||
      extractDescriptionImage(item);
    return normalizeArticle({
      title,
      description,
      image,
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

async function fetchRssArticles(url, feed, provider) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'Mozilla/5.0 (compatible; PulseNews/1.0)'
    }
  });
  if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);

  const xml = await response.text();
  if (Buffer.byteLength(xml, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error(`${provider} response exceeded the allowed size.`);
  }
  const articles = parseRssArticles(xml, feed);
  if (!articles.length) throw new Error(`${provider} returned no usable articles.`);
  return { articles, provider };
}

function extractOpenGraphImage(html) {
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)];
  for (const [tag] of metaTags) {
    const property = tag.match(/\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(1).find(Boolean);
    if (!/^(?:og:image|og:image:url|twitter:image|twitter:image:src)$/i.test(property || '')) continue;
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(1).find(Boolean);
    if (content) return decodeHtmlAttribute(content.trim());
  }
  const imageLink = html.match(/<link\b[^>]*\brel\s*=\s*(?:"[^"]*\bimage_src\b[^"]*"|'[^']*\bimage_src\b[^']*'|[^\s>]*image_src[^\s>]*)[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (imageLink) return decodeHtmlAttribute(imageLink[1] ?? imageLink[2] ?? imageLink[3] ?? '');
  return '';
}

async function resolvePublisherImage(article) {
  if (article.image) return article.image;
  try {
    const response = await fetch(article.url, {
      signal: AbortSignal.timeout(8_000),
      redirect: 'follow',
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; PulseNews/1.0)'
      }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const image = extractOpenGraphImage(html);
    try {
      return normalizeImageUrl(image ? new URL(image, response.url).href : '');
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function isTransientTimeout(error) {
  return error?.name === 'TimeoutError' ||
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.cause?.code) ||
    /timed out|timeout/i.test(error instanceof Error ? error.message : '');
}

async function fetchRssArticlesWithRetry(url, feed, provider) {
  try {
    return await fetchRssArticles(url, feed, provider);
  } catch (error) {
    if (!isTransientTimeout(error)) throw error;
    console.warn(`${provider} timed out (${feed.label}); retrying once.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return fetchRssArticles(url, feed, provider);
  }
}

async function fetchRssCategory(feed) {
  try {
    const result = await fetchRssArticlesWithRetry(createBingRssUrl(feed), feed, 'Bing News RSS');
    const articles = await Promise.all(result.articles.slice(0, 10).map(async (article) => ({
      ...article,
      image: await resolvePublisherImage(article)
    })));
    const publishableArticles = articles.filter((article) => article.image && article.description.trim());
    if (!publishableArticles.length) throw new Error('Bing News RSS returned no stories with usable summaries and photos.');
    return {
      ...result,
      articles: publishableArticles
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Bing News RSS error';
    console.warn(`Bing News RSS request failed (${feed.label}); falling back to Google News RSS: ${message}`);
    const result = await fetchRssArticlesWithRetry(createRssUrl(feed), feed, 'Google News RSS');
    const articles = await Promise.all(result.articles.slice(0, 10).map(async (article) => ({
      ...article,
      image: await resolvePublisherImage(article)
    })));
    return {
      ...result,
      articles: articles.filter((article) => article.image && article.description)
    };
  }
}

async function fetchCategoryWithFallback(feed) {
  if (USE_GNEWS && API_KEY) {
    try {
      const articles = await fetchCategory(feed);
      if (!articles.length) throw new Error('GNews returned no articles.');
      return {
        articles: articles.filter((article) => article.image && article.description),
        provider: 'GNews'
      };
    } catch (error) {
      const message = redactApiKey(error instanceof Error ? error.message : 'Unknown GNews error');
      console.warn(`GNews request failed (${feed.label}); falling back to free RSS: ${message}`);
    }
  }
  return fetchRssCategory(feed);
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

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);?/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);?/g, (_, code) => String.fromCodePoint(Number(code)));
}

function unwrapBingNewsUrl(value) {
  try {
    const redirectUrl = new URL(value);
    const publisherUrl = redirectUrl.hostname === 'www.bing.com'
      ? redirectUrl.searchParams.get('url')
      : null;
    return publisherUrl || value;
  } catch {
    return value;
  }
}

function normalizeImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const imageUrl = new URL(value.trim());
    if (!['https:', 'http:'].includes(imageUrl.protocol)) return null;
    imageUrl.protocol = 'https:';
    return imageUrl.href;
  } catch {
    return null;
  }
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

  const image = normalizeImageUrl(article.image);

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
          .filter((article) => article.image && article.description.trim())
          .slice(0, 10)
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
  if (!articles.length && errors.length) {
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
  ['/donate', ['donate.html', 'text/html; charset=utf-8']],
  ['/donate.html', ['donate.html', 'text/html; charset=utf-8']],
  ['/support', ['support.html', 'text/html; charset=utf-8']],
  ['/support.html', ['support.html', 'text/html; charset=utf-8']],
  ['/account', ['account.html', 'text/html; charset=utf-8']],
  ['/account.html', ['account.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/account.js', ['account.js', 'text/javascript; charset=utf-8']],
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

  try {
    if (url.pathname.startsWith('/api/auth/')) {
      if (await handleAuthRequest(request, response, url.pathname)) return;
      response.writeHead(405, { Allow: url.pathname.endsWith('/me') ? 'GET' : 'POST' });
      response.end('Method not allowed');
      return;
    }

    if (url.pathname === '/api/support' && request.method === 'POST') {
      await loadAppData();
      const body = await readJsonBody(request);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const subject = typeof body.subject === 'string' ? body.subject.trim() : 'General support';
      if (!name || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
        !message || message.length > 5000 || !subject || subject.length > 120) {
        sendJson(response, 400, { error: 'Please provide a name, valid email, subject, and message under 5,000 characters.' });
        return;
      }
      const ticket = {
        id: crypto.randomUUID(),
        name,
        email,
        subject,
        message,
        createdAt: new Date().toISOString()
      };
      appData.supportMessages.push(ticket);
      appData.supportMessages = appData.supportMessages.slice(-5000);
      await saveAppData();
      sendJson(response, 201, { received: true, ticketId: ticket.id });
      return;
    }
    if (url.pathname === '/api/support') {
      response.writeHead(405, { Allow: 'POST' });
      response.end('Method not allowed');
      return;
    }
    if (url.pathname === '/api/donation' && request.method === 'GET') {
      let checkoutUrl = '';
      try {
        const configuredUrl = new URL(process.env.DONATION_CHECKOUT_URL || '');
        if (configuredUrl.protocol === 'https:') checkoutUrl = configuredUrl.href;
      } catch {
        checkoutUrl = '';
      }
      sendJson(response, 200, { checkoutUrl });
      return;
    }
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (statusCode === 500) console.error(`Request failed (${url.pathname}): ${error.message}`);
    sendJson(response, statusCode, {
      error: statusCode === 500 ? 'The request could not be completed. Please try again later.' : error.message
    });
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
