# PulseNews

PulseNews is a plain HTML, CSS, and browser JavaScript news site. Its Node.js server keeps the SerpApi key private and proxies Google News results for Ghana, World, Business, Sports, and Technology.

## Run locally

1. Install Node.js 18 or later.
2. Run `npm install` in this folder.
3. Copy `.env.example` to `.env`.
4. Open `.env` and replace `your_serpapi_api_key_here` with your private SerpApi key.
5. Run `npm start`.
6. Open <http://127.0.0.1:3000>.

Keep the server running while using the site. Opening `index.html` directly with `file://` does not start the API proxy. Never put the SerpApi key in browser files or commit the `.env` file.

## Live headlines

- The browser requests `/api/news` on page load and checks for updates every minute.
- The homepage displays up to 12 latest stories, 10 top headlines, and 10 stories in each category, using all available results up to those limits.
- The server shares a three-hour news cache across visitors by default. Each refresh makes five image-and-headline searches plus five small snippet searches, one pair per category. It also checks the first four publisher pages in each category for their original high-resolution images; this does not use SerpApi searches. Check your plan's quota before reducing the cache interval.
- To change the server cache interval, add `NEWS_REFRESH_INTERVAL_MS` to `.env`. For example, `NEWS_REFRESH_INTERVAL_MS=900000` refreshes every 15 minutes. Check your SerpApi account's search quota before lowering this interval.
- Headlines use SerpApi's Google News engine with Ghana-region (`gl=gh`) searches for Ghana, Business, Sports, and Technology. World uses an international news query. The publisher thumbnail is used instead of the smaller square search-result thumbnail where available.
- PulseNews uses SerpApi's original Google News publisher images and pairs article snippets from Google News search only when publisher URLs or normalized headlines match exactly. Descriptions are not invented, and full articles are not reproduced.
- The frontend prefers original high-resolution images published on each article page, then falls back to the Google News thumbnail. It also shows descriptions, source names, publication times, and links to original stories. It does not substitute unrelated stock photos; unavailable images use a neutral placeholder.
- If SerpApi is unavailable, the site displays an error and the server keeps its last successful results when available.
- Test the API at <http://127.0.0.1:3000/api/news>. A category can be requested at <http://127.0.0.1:3000/api/news?category=ghana>.

See the [SerpApi Google News API documentation](https://serpapi.com/google-news-api) and your account plan for current availability and search limits.
