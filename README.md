# PulseNews

PulseNews is a plain HTML, CSS, and browser JavaScript news site. Its Node.js server aggregates live headlines for Ghana, World, Business, Sports, and Technology from public Google News RSS feeds without requiring an API key. Google News RSS is the default; GNews can optionally be selected, with RSS as its fallback.

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
3. No news API key is required. Render uses Google News RSS by default. To prefer GNews instead, set `NEWS_PROVIDER=gnews` and add `GNEWS_API_KEY` in the service's **Environment** settings; never put a key in `config.js`, `index.html`, or `script.js`.
4. Wait for the service to finish deploying, then open its `https://…onrender.com` URL. The homepage and `/api/news` share the same origin.
5. Set the service URL in `config.js` as `window.PULSENEWS_API_BASE_URL`, then open `index.html` directly. The server allows the `null` origin used by local files.

When a separate frontend host is used, set the backend's `FRONTEND_ORIGINS` environment variable to the exact frontend origin(s), separated by commas. The default permits local development origins and `file://`; same-origin Render deployment needs no CORS configuration.

## Live headlines

- The browser requests `/api/news` on page load and checks for updates every minute.
- `config.js` contains only the public backend URL. Leave it blank for same-origin/local-server use; set it to the deployed Render URL to load live headlines when opening `index.html` directly.
- The homepage displays up to 12 latest stories, 10 top headlines, and 10 stories in each category, using all available results up to those limits.
- The server caches feed results for 15 minutes by default and requests one public Google News RSS feed per category. To change the interval, add `NEWS_REFRESH_INTERVAL_MS` to `.env`.
- RSS headlines are collected by the backend without an API key. To prefer GNews, set `NEWS_PROVIDER=gnews` and configure `GNEWS_API_KEY`; RSS remains the fallback. Articles link to their original publishers.
- Google News RSS does not provide descriptions or reliable images; unavailable images use a neutral placeholder. When optional GNews is configured, the frontend can use its article images.
- If feeds are unavailable, the site displays an error and the server keeps its last successful results when available.
- Test the local API at <http://127.0.0.1:3000/api/news>. A category can be requested at <http://127.0.0.1:3000/api/news?category=ghana>. Render checks <https://your-service.onrender.com/healthz> after deploy.

See the [Google News RSS feeds](https://news.google.com/rss/) and, if configured, the [GNews API documentation](https://docs.gnews.io/).
