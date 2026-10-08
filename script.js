const searchToggle = document.querySelector('.search-toggle');
const searchPanel = document.querySelector('#search-panel');
const searchInput = document.querySelector('#news-search');
const clearSearch = document.querySelector('#clear-search');
const searchStatus = document.querySelector('#search-status');
const menuToggle = document.querySelector('.menu-toggle');
const primaryNav = document.querySelector('#primary-nav');
const liveHeadlines = document.querySelector('#live-headlines');
const liveStatus = document.querySelector('#live-status');
const feedNotice = document.querySelector('#feed-notice');
const feedNoticeTitle = document.querySelector('#feed-notice-title');
const feedNoticeMessage = document.querySelector('#feed-notice-message');
const breakingHeadline = document.querySelector('#breaking-headline');
const LATEST_ARTICLE_COUNT = 12;
const CATEGORY_ARTICLE_COUNT = 10;
const TOP_HEADLINE_COUNT = 10;
const configuredApiBaseUrl = typeof window.PULSENEWS_API_BASE_URL === 'string'
  ? window.PULSENEWS_API_BASE_URL.trim().replace(/\/+$/, '')
  : '';
const localServerMode = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const apiBaseUrl = localServerMode ? '' : configuredApiBaseUrl;
const directFileMode = window.location.protocol === 'file:' && !apiBaseUrl;
const refreshEveryMs = 60_000;
let requestInProgress = false;

function getNewsApiUrl() {
  if (apiBaseUrl) return `${apiBaseUrl}/api/news`;
  if (window.location.protocol === 'file:') {
    throw new Error('Deploy PulseNews on Render, then set its service URL in config.js to load live news from this file.');
  }
  return '/api/news';
}

function setSearchOpen(open) {
  searchToggle.setAttribute('aria-expanded', String(open));
  searchToggle.setAttribute('aria-label', open ? 'Close search' : 'Open search');
  searchPanel.hidden = !open;
  if (open) searchInput.focus();
}

searchToggle.addEventListener('click', () => {
  setSearchOpen(searchToggle.getAttribute('aria-expanded') !== 'true');
});

function filterStories() {
  const query = searchInput.value.trim().toLowerCase();
  const stories = [...document.querySelectorAll('.story')];
  let visibleCount = 0;

  stories.forEach((story) => {
    const searchableText = `${story.textContent} ${story.dataset.search || ''}`.toLowerCase();
    const matches = !query || searchableText.includes(query);
    story.hidden = !matches;
    if (matches) visibleCount += 1;
  });

  searchStatus.hidden = !query || visibleCount > 0;
  searchStatus.textContent = query && visibleCount === 0
    ? 'No headlines match your search. Try another topic.'
    : '';
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function isPublishableArticle(article) {
  return Boolean(article && typeof article.title === 'string' && article.title.trim() &&
    safeExternalUrl(article.url));
}

function getValidImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' ||
      !/\.(?:jpe?g|png|webp)$/i.test(url.pathname) ||
      /(?:logo|icon|avatar|sprite|default)/i.test(url.href)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function formatPublishedAt(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Publication time unavailable';
  return date.toLocaleString('en-GH', {
    timeZone: 'Africa/Accra',
    dateStyle: 'medium',
    timeStyle: 'short'
  }) + ' GMT';
}

function showEmptyNewsMessage(container, asListItem = false) {
  const message = document.createElement(asListItem ? 'li' : 'p');
  message.className = 'live-placeholder';
  message.textContent = 'No stories are available right now.';
  container.replaceChildren(message);
}

function watchImageLoad(image, imageLink, story) {
  image.addEventListener('load', () => {
    if (image.naturalWidth >= 600) return;
    imageLink.remove();
    story.classList.add('text-only-story');
  });
  image.addEventListener('error', () => {
    imageLink.remove();
    story.classList.add('text-only-story');
  });
}

function addArticleImage(container, article, className) {
  const source = getValidImageUrl(article.image);
  if (!source) return false;

  const imageLink = document.createElement('a');
  imageLink.className = className;
  imageLink.href = safeExternalUrl(article.url);
  if (!imageLink.href) return;
  imageLink.target = '_blank';
  imageLink.rel = 'noopener noreferrer';

  const image = document.createElement('img');
  image.src = source;
  image.alt = article.title;
  image.loading = className.includes('lead-image') ? 'eager' : 'lazy';
  image.decoding = 'async';
  if (className.includes('lead-image')) image.fetchPriority = 'high';
  image.referrerPolicy = 'no-referrer';
  watchImageLoad(image, imageLink, container);
  imageLink.append(image);
  container.append(imageLink);
  return true;
}

function addArticleCategory(container, article) {
  const category = document.createElement('p');
  category.className = 'article-category';
  category.append(document.createTextNode(article.categoryLabel || 'News'));
  const rule = document.createElement('span');
  rule.className = 'category-rule';
  category.append(rule, document.createTextNode(article.source || 'News source'));
  container.append(category);
}

function createArticleCard(article) {
  if (!isPublishableArticle(article)) return null;
  const story = document.createElement('article');
  story.className = 'topic-story story';
  story.dataset.articleId = article.id;
  story.dataset.search = `${article.categoryLabel} ${article.title} ${article.description} ${article.source}`;

  if (!addArticleImage(story, article, 'topic-image image-link')) {
    story.classList.add('text-only-story');
  }

  const content = document.createElement('div');
  content.className = 'topic-copy';
  addArticleCategory(content, article);

  const heading = document.createElement('h3');
  const titleLink = document.createElement('a');
  titleLink.href = safeExternalUrl(article.url) || '#latest';
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  titleLink.textContent = article.title;
  heading.append(titleLink);
  content.append(heading);

  if (article.description) {
    const description = document.createElement('p');
    description.textContent = article.description;
    content.append(description);
  }

  const details = document.createElement('div');
  details.className = 'article-details';
  const published = document.createElement('span');
  published.className = 'article-time';
  published.textContent = formatPublishedAt(article.publishedAt);
  const readLink = document.createElement('a');
  readLink.className = 'read-story';
  readLink.href = safeExternalUrl(article.url) || '#latest';
  readLink.target = '_blank';
  readLink.rel = 'noopener noreferrer';
  readLink.textContent = 'Read story →';
  details.append(published, readLink);
  content.append(details);
  story.append(content);
  return story;
}

function createLeadStory(article) {
  if (!isPublishableArticle(article)) return null;
  const lead = document.createElement('article');
  lead.className = 'lead-story story';
  lead.dataset.articleId = article.id;
  lead.dataset.search = `${article.categoryLabel} ${article.title} ${article.description} ${article.source}`;
  if (!addArticleImage(lead, article, 'lead-image image-link')) {
    lead.classList.add('text-only-story');
  }

  const content = document.createElement('div');
  content.className = 'lead-copy';
  addArticleCategory(content, article);

  const heading = document.createElement('h1');
  const titleLink = document.createElement('a');
  titleLink.href = safeExternalUrl(article.url) || '#live-news';
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  titleLink.textContent = article.title;
  heading.append(titleLink);
  content.append(heading);

  if (article.description) {
    const description = document.createElement('p');
    description.className = 'lead-summary';
    description.textContent = article.description;
    content.append(description);
  }

  const details = document.createElement('div');
  details.className = 'article-byline';
  const publisher = document.createElement('span');
  publisher.textContent = article.source || 'News source';
  const published = document.createElement('span');
  published.textContent = formatPublishedAt(article.publishedAt);
  details.append(publisher, published);
  content.append(details);

  const readLink = document.createElement('a');
  readLink.className = 'read-link';
  readLink.href = safeExternalUrl(article.url) || '#live-news';
  readLink.target = '_blank';
  readLink.rel = 'noopener noreferrer';
  readLink.append(document.createTextNode('Read the story '));
  const arrow = document.createElement('span');
  arrow.textContent = '→';
  readLink.append(arrow);
  content.append(readLink);
  lead.append(content);
  return lead;
}

function renderTopHeadlines(articles) {
  const list = document.querySelector('#top-headlines');
  list.replaceChildren();
  const publishableArticles = articles.filter(isPublishableArticle);
  publishableArticles.slice(0, TOP_HEADLINE_COUNT).forEach((article, index) => {
    const item = document.createElement('li');
    item.className = 'story';
    item.dataset.articleId = article.id;
    item.dataset.search = `${article.categoryLabel} ${article.title} ${article.source}`;
    const ranking = document.createElement('span');
    ranking.className = 'ranking';
    ranking.textContent = String(index + 1).padStart(2, '0');
    const content = document.createElement('div');
    addArticleCategory(content, article);
    const heading = document.createElement('h3');
    const link = document.createElement('a');
    link.href = safeExternalUrl(article.url) || '#live-news';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = article.title;
    heading.append(link);
    const time = document.createElement('span');
    time.className = 'article-time';
    time.textContent = formatPublishedAt(article.publishedAt);
    content.append(heading, time);
    item.append(ranking, content);
    list.append(item);
  });
  if (!publishableArticles.length) showEmptyNewsMessage(list, true);
}

function renderNews(news) {
  const articles = (news.articles || []).filter(isPublishableArticle);
  const categories = news.categories || {};
  const lead = articles[0];

  if (lead) {
    document.querySelector('#lead-story').replaceChildren(createLeadStory(lead));
    const breakingLink = document.createElement('a');
    breakingLink.dataset.articleId = lead.id;
    breakingLink.href = safeExternalUrl(lead.url) || '#live-news';
    breakingLink.target = '_blank';
    breakingLink.rel = 'noopener noreferrer';
    breakingLink.textContent = lead.title;
    breakingHeadline.replaceChildren(breakingLink);
  } else {
    showEmptyNewsMessage(document.querySelector('#lead-story'));
    breakingHeadline.textContent = 'No stories are available right now.';
  }

  liveHeadlines.replaceChildren();
  const latest = [...articles]
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, LATEST_ARTICLE_COUNT);
  if (latest.length) {
    latest.forEach((article) => liveHeadlines.append(createArticleCard(article)));
  } else {
    showEmptyNewsMessage(liveHeadlines);
  }

  const ranked = [...articles]
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  renderTopHeadlines(ranked);

  ['ghana', 'world', 'business', 'sports', 'technology'].forEach((category) => {
    const grid = document.querySelector(`#category-${category}`);
    const categoryArticles = (categories[category]?.articles || []).filter(isPublishableArticle);
    grid.replaceChildren();
    if (categoryArticles.length) {
      categoryArticles.slice(0, CATEGORY_ARTICLE_COUNT).forEach((article) => grid.append(createArticleCard(article)));
    } else {
      const empty = document.createElement('p');
      empty.className = 'live-placeholder';
      const error = news.categoryErrors?.[category];
      const provider = news.provider || 'news feeds';
      empty.textContent = error
        ? /request limit|quota|too many requests/i.test(error)
          ? `${provider} has reached its request limit for ${category} news. Headlines should return when the provider quota resets.`
          : `${category} news could not be refreshed. Please try again later.`
        : `No ${category} stories are available right now.`;
      grid.append(empty);
    }
  });
  filterStories();
}

async function loadLiveNews() {
  if (requestInProgress) return;
  requestInProgress = true;
  liveStatus.textContent = 'Checking for news updates…';

  try {
    const response = await fetch(getNewsApiUrl(), { cache: 'no-store' });
    const news = await response.json();
    if (!response.ok) throw new Error(news.error || `News service returned ${response.status}`);

    renderNews(news);
    const updated = new Date(news.updatedAt);
    const updatedTime = Number.isNaN(updated.getTime())
      ? 'time unavailable'
      : updated.toLocaleString('en-GH', {
        timeZone: 'Africa/Accra',
        dateStyle: 'medium',
        timeStyle: 'short'
      }) + ' GMT';
    const refreshMinutes = Math.round((news.nextRefreshMs || 10_800_000) / 60_000);
    liveStatus.textContent = `Live ${news.provider || 'news'} · updated ${updatedTime} · refreshes every ${refreshMinutes} min`;
    feedNotice.hidden = !news.warning;
    feedNoticeTitle.textContent = news.warning ? 'Some sections could not be updated' : '';
    feedNoticeMessage.textContent = news.warning || '';
  } catch (error) {
    liveStatus.textContent = 'News is unavailable';
    feedNotice.hidden = false;
    feedNoticeTitle.textContent = 'Live news is temporarily unavailable';
    feedNoticeMessage.textContent = error.message;
    breakingHeadline.textContent = 'Live headlines are unavailable. See the news section below for details.';
    if (!liveHeadlines.querySelector('.story')) {
      const message = document.createElement('p');
      message.className = 'live-placeholder';
      if (window.location.protocol === 'file:') {
        message.textContent = apiBaseUrl
          ? `Could not reach the Render news service: ${error.message}`
          : error.message;
      } else {
        message.textContent = 'Start the PulseNews backend with npm start to load live news.';
      }
      liveHeadlines.replaceChildren(message);
      document.querySelector('#lead-story').replaceChildren(message.cloneNode(true));
      const topHeadlinesMessage = document.createElement('li');
      topHeadlinesMessage.className = 'loading-item';
      topHeadlinesMessage.textContent = 'News could not be loaded.';
      document.querySelector('#top-headlines').replaceChildren(topHeadlinesMessage);
      ['ghana', 'world', 'business', 'sports', 'technology'].forEach((category) => {
        document.querySelector(`#category-${category}`).replaceChildren(message.cloneNode(true));
      });
    }
  } finally {
    requestInProgress = false;
  }
}

searchInput.addEventListener('input', filterStories);
clearSearch.addEventListener('click', () => {
  searchInput.value = '';
  filterStories();
  searchInput.focus();
});

menuToggle.addEventListener('click', () => {
  const open = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  primaryNav.classList.toggle('open', open);
});

primaryNav.addEventListener('click', (event) => {
  if (event.target.closest('a')) {
    primaryNav.classList.remove('open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (searchToggle.getAttribute('aria-expanded') === 'true') {
      setSearchOpen(false);
      searchToggle.focus();
    }
    primaryNav.classList.remove('open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation');
  }
});

document.querySelector('#today-date').textContent = new Intl.DateTimeFormat('en-GH', {
  dateStyle: 'full',
  timeZone: 'Africa/Accra'
}).format(new Date());
document.querySelector('#year').textContent = new Date().getFullYear();
loadLiveNews();
window.setInterval(loadLiveNews, refreshEveryMs);
