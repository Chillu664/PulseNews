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
const breakingHeadline = document.querySelector('#breaking-headline');
const refreshEveryMs = 60_000;
const LATEST_ARTICLE_COUNT = 12;
const CATEGORY_ARTICLE_COUNT = 10;
const TOP_HEADLINE_COUNT = 10;
let requestInProgress = false;

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

function formatPublishedAt(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Publication time unavailable';
  return date.toLocaleString('en-GH', {
    timeZone: 'Africa/Accra',
    dateStyle: 'medium',
    timeStyle: 'short'
  }) + ' GMT';
}

function watchImageLoad(image, imageLink, className) {
  image.addEventListener('error', () => {
    const fallback = safeExternalUrl(image.dataset.fallbackImage);
    if (fallback && image.dataset.fallbackAttempted !== 'true' && fallback !== image.src) {
      image.dataset.fallbackAttempted = 'true';
      image.src = fallback;
      return;
    }
    const placeholder = document.createElement('div');
    placeholder.className = className.replace('image-link', 'image-placeholder');
    placeholder.setAttribute('aria-hidden', 'true');
    imageLink.replaceWith(placeholder);
  });
}

function addArticleImage(container, article, className) {
  const source = safeExternalUrl(article.image);
  if (!source) {
    const placeholder = document.createElement('div');
    placeholder.className = className.replace('image-link', 'image-placeholder');
    placeholder.setAttribute('aria-hidden', 'true');
    container.append(placeholder);
    return;
  }

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
  const fallbackImage = safeExternalUrl(article.fallbackImage);
  if (fallbackImage && fallbackImage !== source) image.dataset.fallbackImage = fallbackImage;
  image.referrerPolicy = 'no-referrer';
  watchImageLoad(image, imageLink, className);
  imageLink.append(image);
  container.append(imageLink);
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
  const story = document.createElement('article');
  story.className = 'topic-story story';
  story.dataset.search = `${article.categoryLabel} ${article.title} ${article.description} ${article.source}`;

  addArticleImage(story, article, 'topic-image image-link');

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
  const lead = document.createElement('article');
  lead.className = 'lead-story story';
  lead.dataset.search = `${article.categoryLabel} ${article.title} ${article.description} ${article.source}`;
  addArticleImage(lead, article, 'lead-image image-link');

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
  articles.slice(0, TOP_HEADLINE_COUNT).forEach((article, index) => {
    const item = document.createElement('li');
    item.className = 'story';
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
}

function renderNews(news) {
  const articles = news.articles || [];
  const categories = news.categories || {};
  const lead = articles[0];

  if (lead) {
    document.querySelector('#lead-story').replaceChildren(createLeadStory(lead));
    const breakingLink = document.createElement('a');
    breakingLink.href = safeExternalUrl(lead.url) || '#live-news';
    breakingLink.target = '_blank';
    breakingLink.rel = 'noopener noreferrer';
    breakingLink.textContent = lead.title;
    breakingHeadline.replaceChildren(breakingLink);
  } else {
    document.querySelector('#lead-story').innerHTML = '<p class="live-placeholder">No headlines are available right now.</p>';
    breakingHeadline.textContent = 'No headlines are available right now.';
  }

  liveHeadlines.replaceChildren();
  const latest = [...articles]
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, LATEST_ARTICLE_COUNT);
  if (latest.length) {
    latest.forEach((article) => liveHeadlines.append(createArticleCard(article)));
  } else {
    liveHeadlines.innerHTML = '<p class="live-placeholder">No headlines are available right now.</p>';
  }

  const ranked = [...articles]
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  renderTopHeadlines(ranked);

  ['ghana', 'world', 'business', 'sports', 'technology'].forEach((category) => {
    const grid = document.querySelector(`#category-${category}`);
    const categoryArticles = categories[category]?.articles || [];
    grid.replaceChildren();
    if (categoryArticles.length) {
      categoryArticles.slice(0, CATEGORY_ARTICLE_COUNT).forEach((article) => grid.append(createArticleCard(article)));
    } else {
      const empty = document.createElement('p');
      empty.className = 'live-placeholder';
      empty.textContent = `No ${category} headlines are available right now.`;
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
    const response = await fetch('/api/news', { cache: 'no-store' });
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
    liveStatus.textContent = `Updated ${updatedTime} · news cache refreshes every ${refreshMinutes} min`;
    feedNotice.hidden = !news.warning;
    feedNotice.textContent = news.warning || '';
  } catch (error) {
    liveStatus.textContent = 'News is unavailable';
    feedNotice.hidden = false;
    feedNotice.textContent = error.message;
    breakingHeadline.textContent = 'Live headlines are unavailable. See the news section below for details.';
    if (!liveHeadlines.querySelector('.story')) {
      const message = document.createElement('p');
      message.className = 'live-placeholder';
      message.textContent = 'Add a SerpApi key to the .env file and restart the server to load live news.';
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
