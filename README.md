# PulseNews

PulseNews is a plain HTML, CSS, and browser JavaScript news site. Its Node.js server aggregates live headlines for Ghana, World, Business, Sports, and Technology from public Bing News RSS feeds without requiring an API key. Google News RSS is the fallback; GNews can optionally be selected, with free RSS sources as its fallback.

## Run locally

1. Install Node.js 18 or later.
2. Run `npm install` in this folder.
3. Run `npm start`.
4. Open <http://127.0.0.1:3000>.

Keep the server running while using the site locally. To open `index.html` directly and still get live headlines, first deploy the backend to Render (see below), then set its public service URL in `config.js`. RSS collection runs on the backend, so the browser needs no news-provider API key.

## Deploy on Render

The included `render.yaml` deploys the Node server and homepage together. The server serves the frontend, collects public RSS feeds, binds to Render's assigned port, and exposes `/healthz` for deployment health checks.

1. Push this project to a GitHub repository. Confirm that `.env` is not committed; `.gitignore` excludes it.
2. In Render, choose **New → Blueprint**, connect the repository, and deploy the `render.yaml` blueprint.
3. No news API key is required. Render uses Bing News RSS by default, with Google News RSS as a fallback. To prefer GNews instead, set `NEWS_PROVIDER=gnews` and add `GNEWS_API_KEY` in the service's **Environment** settings; never put a key in `config.js`, `index.html`, or `script.js`.
4. Wait for the service to finish deploying, then open its `https://…onrender.com` URL. The homepage and `/api/news` share the same origin.
5. Set the service URL in `config.js` as `window.PULSENEWS_API_BASE_URL`, then open `index.html` directly. The server allows the `null` origin used by local files.

When a separate frontend host is used, set the backend's `FRONTEND_ORIGINS` environment variable to the exact frontend origin(s), separated by commas. The default permits local development origins and `file://`; same-origin Render deployment needs no CORS configuration.

## Live headlines

- The browser requests `/api/news` on page load and checks for updates every minute.
- `config.js` contains only the public backend URL. Leave it blank for same-origin/local-server use; set it to the deployed Render URL to load live headlines when opening `index.html` directly.
- The homepage displays up to 12 latest stories, 10 top headlines, and 10 stories in each category, using all available results up to those limits.
- The server caches feed results for 15 minutes by default and requests one public news feed per category. To change the interval, add `NEWS_REFRESH_INTERVAL_MS` to `.env`.
- Headlines, summaries, and image URLs supplied by the selected news feed are collected by the backend without an API key. To prefer GNews, set `NEWS_PROVIDER=gnews` and configure `GNEWS_API_KEY`; Bing News RSS is used when GNews fails or reaches its quota, with Google News RSS as the final fallback. Articles link to the news source.
- A timed-out RSS request is retried once before the server falls back to the next feed provider. Persistent upstream timeouts are reported rather than hidden.
- Google News RSS links to its own article redirect pages and its RSS description is only a repeated headline/publisher wrapper; the app omits that wrapper rather than presenting it as a story summary. Google News is retained as a final headlines-only fallback.
- Stories are returned even when they have no usable image. Only the image URL supplied by the selected news feed is considered; it must be HTTPS and have a JPG, PNG, or WebP URL without logo, icon, avatar, sprite, or default markers. The browser displays it only after it loads successfully at 600 pixels wide or more. Stories without a valid image remain as text-only cards.
- No publisher pages are scraped for images or summaries, and there are no stock-photo or category-image fallbacks. Bing News RSS availability and image coverage vary by category and publisher, so text-only cards preserve stories that have no valid photo.
- If feeds are unavailable, the site displays an error and the server keeps its last successful results when available.
- Test the local API at <http://127.0.0.1:3000/api/news>. A category can be requested at <http://127.0.0.1:3000/api/news?category=ghana>. Render checks <https://your-service.onrender.com/healthz> after deploy.

See [Bing News](https://www.bing.com/news), the [Google News RSS feeds](https://news.google.com/rss/), and, if configured, the [GNews API documentation](https://docs.gnews.io/).

## Project file guide

| File or folder | Purpose |
| --- | --- |
| `index.html` | Page structure, navigation, search controls, news sections, and footer. It loads the stylesheet, public configuration, and browser script. |
| `styles.css` | Visual theme, responsive layouts, typography, and edge-to-edge story image frames using `object-fit: cover`. |
| `script.js` | Browser behavior: selects the API URL, fetches and renders headlines, refreshes status, filters search results, and uses text-only cards when an image is unusable. On `localhost` it uses the local server API. |
| `server.js` | Node HTTP server and news backend. It serves the page and `/api/news`, fetches RSS or optional GNews, normalizes articles and API-provided image URLs, caches results, and exposes `/healthz`. |
| `config.js` | Public frontend setting for the deployed API base URL. It is not a place for secrets. Localhost uses its same-origin local API. |
| `package.json` | Project metadata, Node engine requirement, npm start/dev scripts, and runtime/development dependencies. |
| `package-lock.json` | Exact npm dependency versions used by `npm ci` and reproducible installs. |
| `render.yaml` | Render Blueprint settings: Node service, install/start commands, health check, and default RSS environment settings. |
| `.env.example` | Safe template showing optional local environment variables; copy it to `.env` and add private values there if needed. |
| `.gitignore` | Excludes installed dependencies and private `.env` files from Git while allowing `.env.example`. |
| `.env` | Local private settings, if present. Keep it secret and do not commit or share it. |
| `node_modules/` | Installed npm packages; generated by npm and excluded from Git. |

## How the app works

1. The browser loads `index.html`, `styles.css`, `config.js`, and `script.js`.
2. `script.js` requests `/api/news`. A local browser address such as `http://127.0.0.1:3000` uses the local server; a deployed page uses its same-origin API, while directly opened files can use the public URL from `config.js`.
3. `server.js` fetches news for Ghana, World, Business, Sports, and Technology. Bing RSS is the default, Google News RSS is the fallback, and GNews is optional.
4. Stories are kept whether or not they have a photo. The browser uses only the image URL returned by the feed and displays it only when it is HTTPS, JPG/PNG/WebP, loads, and is at least 600 pixels wide; otherwise the story remains visible as a text-only card.
5. The server caches feed results for 15 minutes by default; the browser checks for updates every minute. If a refresh fails, the page reports the issue and the backend can continue serving its last successful cache.

### Local commands

- `npm install` installs dependencies.
- `npm start` starts the app on port 3000 by default (or the `PORT` environment variable).
- `npm run dev` starts the server with Nodemon for automatic restarts during development.
- `GET /healthz` checks that the server is responding.
- `GET /api/news` returns the news payload; add `?category=ghana`, `world`, `business`, `sports`, or `technology` to request one category.

The repository does not currently define an automated test script. For a quick code check, run `node --check server.js`, `node --check script.js`, and `git diff --check`.
