# PulseNews project progress

Updated: 6 October 2026

## Current status

- The public site is https://pulsenews-phwt.onrender.com.
- The public Render service passed its `/healthz` check during the latest verification.
- The published GitHub branch is `main`, at commit `00255e8` (`Apply live news card styles`).
- The deployed category sections use the stacked photo-card layout used by the latest-news section. Desktop live validation showed 10 Ghana cards and the live feed status.
- The local working tree has unpublished changes in `README.md`, `package.json`, `package-lock.json`, `script.js`, and `server.js`, plus these progress notes. These changes have not been pushed or deployed. The local `.env` file is private and must not be committed or copied into notes.
- The default deployment uses free Render hosting. Free instances can sleep when idle, so the first request may take longer to respond.

## Progress history

1. **Initial app:** Built a responsive, plain HTML/CSS/JavaScript news homepage with a Node.js backend.
2. **Live RSS backend:** Moved news fetching to the backend so the browser does not need provider credentials. Added Render configuration, `/api/news`, `/healthz`, per-category feeds, caching, and fallback handling.
3. **Deployment setup:** Added the Render Blueprint, public backend URL configuration, safe environment examples, and local development scripts.
4. **Richer live feeds:** Added Bing News RSS to improve available headlines and image metadata. Google News RSS remains a fallback. GNews can be enabled with a server-side key, but quota limits can cause fallback to RSS.
5. **Photo handling:** Added higher-resolution Bing thumbnail requests, publisher Open Graph/Twitter metadata lookups, feed image fallbacks, and low-resolution checks. The current local filter requires both photos and descriptions for every displayed story.
6. **Page loading on localhost:** Updated the browser to use the local same-origin API on `localhost` and `127.0.0.1`, instead of always trying the deployed API. This avoids local CORS failures when the Node server is running.
7. **Live-news visual style:** Applied stacked image-and-story cards to category sections, with responsive adjustments for mobile. Published this stylesheet-only update as `00255e8`.
8. **Project documentation:** Expanded the README with a project file guide, app flow, and local commands. This documentation update is still local.

## App flow

1. `index.html` provides the masthead, navigation, search, lead story, latest-news area, top headlines, five category sections, and footer.
2. `styles.css` defines the dark responsive newspaper design, live-news cards, and image frames.
3. `script.js` chooses the local or configured API URL, fetches and renders stories, updates live status, filters search, and handles image failures and fallbacks.
4. `server.js` serves the page and API, fetches provider feeds, normalizes story data, checks a bounded number of publisher pages for metadata, caches the results, and reports health.
5. The browser requests `/api/news`; the backend supplies items for Ghana, World, Business, Sports, and Technology. News is cached for 15 minutes by default, while the browser checks for updates every minute.

## File guide

| File | Purpose and status |
| --- | --- |
| `index.html` | Main page structure and accessible controls. Deployed. |
| `styles.css` | Responsive design, 16:9 image frames, and stacked live-news/category cards. The latest card-style change is deployed. |
| `script.js` | Browser-side fetch/render/search behavior, story eligibility filtering, and removal of articles with failed photos. Current local updates are unpublished. |
| `server.js` | Node server, RSS/GNews providers, feed parsing, publisher metadata enrichment, cache, API routes, and health check. Current local updates are unpublished. |
| `config.js` | Public API base URL for direct-file use. The app served by Render uses its same-origin API; local browser hosts use their local server. |
| `package.json` | Node engine and npm scripts/dependencies. Local changes include the development auto-restart setup and are unpublished. |
| `package-lock.json` | Locked npm dependency versions. Local changes are unpublished. |
| `render.yaml` | Render service definition, install/start commands, health check, and RSS defaults. |
| `.env.example` | Safe template for optional local settings. |
| `.gitignore` | Keeps `node_modules` and private `.env` files out of Git. |
| `README.md` | Setup, deploy, data flow, image behavior, file guide, and commands. New documentation changes are local. |
| `.env` | Local private configuration, if present. Do not publish or include its contents in notes. |
| `node_modules/` | Installed dependencies; generated locally and not committed. |

## News and image behavior

- Bing News RSS is the preferred free RSS feed. Google News RSS is the final RSS fallback. GNews is optional and requires a server-side environment key; quota or provider errors fall back to RSS.
- Feed and publisher photos are used where supplied. The server requests large Bing thumbnails and checks selected article pages for image metadata, with bounds on time, page size, redirects, and concurrency.
- Stories without a non-empty description or real image URL are filtered out. If an image fails or is too small, the browser tries a usable feed-image fallback; if none works, it removes that story from the displayed lists instead of showing an illustration.
- Story cards use 16:9 image frames. Publisher-original photos are contained on a dark background to avoid cropping; other card photos use the live card crop behavior.
- News volume and exact photo coverage vary by provider and category.

## Deployment and change boundary

Published commits on `main`:

- `50191f5` — deploy RSS-backed live news
- `6a7775f` — set deployed live news service URL
- `eb3f9aa` — use Bing RSS for image-rich fallback
- `00255e8` — apply live news card styles

The current published site includes the deployed frontend and the stylesheet card-layout change. The more recent local server and browser image improvements, package changes, and expanded project notes are not published. Keep them local unless deployment is explicitly requested.

## Local development and checks

- Install: `npm install`
- Start: `npm start` (port 3000 by default; set `PORT` to use another port such as 3111)
- Auto-restart development: `npm run dev`
- Health: `GET http://127.0.0.1:3000/healthz`
- All categories: `GET http://127.0.0.1:3000/api/news`
- One category: `GET http://127.0.0.1:3000/api/news?category=ghana`
- Quick code checks: `node --check server.js`, `node --check script.js`, `git diff --check`

Keep the server process running while opening the local site. If a local port is already in use, choose another port rather than stopping an unknown process.

## Latest local review

Review and integration test completed on 6 October 2026. No changes were committed, pushed, or deployed during this review.

- `node --check server.js`: passed.
- `node --check script.js`: passed.
- `git diff --check`: passed.
- Local server started on port 3112 with `NEWS_PROVIDER=rss`.
- `/healthz`: HTTP success; returned `{"status":"ok"}`.
- `/api/news`: returned 44 stories across five categories, using Bing News RSS.
- Each category endpoint returned a valid story array. Feed availability varies; this run returned four World stories and ten for each other category.
- Invalid category query returned HTTP 400.
- Browser integration check rendered 67 story cards. All 52 rendered image elements loaded successfully; no broken image elements remained.

| Category | Stories | Feed image URLs | Loaded photos in browser | Labeled fallback illustrations |
| --- | ---: | ---: | ---: | ---: |
| Ghana | 10 | 9 | 8 | 2 |
| World | 4 | 4 | 4 | 0 |
| Business | 10 | 10 | 10 | 0 |
| Sports | 10 | 10 | 9 | 1 |
| Technology | 10 | 9 | 9 | 1 |

The browser showed four illustrations: two Ghana, one Sports, and one Technology. Two stories had no feed image URL; two more had a supplied image that was too small for its card, so it was rejected rather than displayed blurred. The image counts describe URL availability and successful loading, not independent verification that every photo depicts the exact event.

### Timeout failure follow-up

- A later default-provider startup produced timeout errors across all five categories.
- Direct provider probes then returned HTTP 200 from Bing RSS in 0.84 seconds and Google News RSS in 1.82 seconds; a fresh app instance completed the five-category RSS refresh in 6.5 seconds. This points to a transient upstream/network timeout rather than a syntax or persistent configuration failure.
- `server.js` now retries an RSS request once after a 500 ms pause when it fails with a timeout, before using the existing alternate-provider fallback. Non-timeout HTTP and parsing errors are not retried.
- After the retry change, syntax and diff checks passed; a fresh default-config server passed `/healthz` and returned 47 stories from Bing News RSS.
- Post-fix category results: Ghana 10 stories (9 image URLs), World 7 (7), Business 10 (10), Sports 10 (10), Technology 10 (9).
- The retry change has not been committed or deployed.

### Require photos and descriptions

- The API filters each category to stories with both a non-empty description and a real image URL after provider/publisher metadata enrichment.
- The browser applies the same filter to lead, latest, top-headline, and category displays. If a displayed image fails or is too small and has no usable feed-image fallback, the story is removed from all displayed lists.
- Both Bing and Google RSS paths apply the eligibility filter. Empty sections explain that no stories meeting both requirements are currently available; missing-photo illustrations are no longer shown as news cards.
- Removed the illustration styles from `styles.css`; the active news UI contains no text-only/fallback-image cards for ineligible stories.
- Validation: syntax and diff checks passed. `/healthz` returned `ok`; all 41 articles in `/api/news` and every category endpoint had an HTTPS image URL and non-empty description (Ghana 9, World 5, Business 10, Sports 9, Technology 8).
- Browser validation loaded 54 photos with zero broken images or illustrations. A second run blocked every image request; all affected story cards were removed, leaving zero story cards and zero illustrations.
- This change is local and not committed or deployed. Run the syntax, endpoint, and browser checks before committing.

### Review risks

- Checking publisher metadata for up to 10 articles in every category can add latency; the lookups are concurrent but bounded.
- Publisher sites can block metadata requests or omit image metadata. RSS image availability also changes, as seen in the four-story World result.
- No automated test suite is defined; syntax, endpoints, and browser rendering were verified manually.
- All recent backend, browser, package, and documentation changes remain local and must be reviewed before any commit or deploy.

## Recommended next steps

1. Review the noted publisher-lookup latency and image-coverage tradeoffs.
2. Decide whether to commit the reviewed local changes; do not deploy without an explicit request.
3. After any future deploy, check `/healthz`, `/api/news`, image behavior, and the public page.
