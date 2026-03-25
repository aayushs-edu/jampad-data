# JamPad — Project Context for Claude Code

## What JamPad Is

JamPad is a web app that helps game jam participants overcome **theme interpretation paralysis** and **scope creep**. The core feature is an "Inspiration Engine" that surfaces relevant games and mechanics based on a user-submitted theme and constraints.

Users will be redirected to the itch.io pages of games in the results, so we don't need deep game data — title, URL, cover image, and short description are sufficient.

## Current Data Layer

- **Itch jam dataset**: ~97 jams, ~3,673 games in `data/jam_data/` with full details (descriptions, tags, genres, engines, screenshots, ratings)
- **IGDB taxonomy cache**: `data/igdb_taxonomies.json` — themes (22), genres (23), keywords (6,923), perspectives (7), game modes (6), engines (1,427)
- **Itch → IGDB mapping**: `data/itch_to_igdb_map.json` — maps itch freeform genres/tags/engines to IGDB IDs
- **IGDB client module**: `scripts/igdb_client.js` — authenticated, rate-limited, with `findGames()`, `searchGame()`, `getGame()`, `imageUrl()`
- **Inverted index + game profiles**: `data/inverted_index.json`, `data/game_profiles.json` — pre-built from jam data
- **Theme catalog**: `data/theme_catalog.json` — extracted jam themes
- **Scraping scripts**: `scripts/scrape_jam_index.js`, `scripts/collect_jam_data.js`, `scripts/build_inverted_index.js`
- **Twitch credentials** in `.env` as `TWITCH_CLIENTID` and `TWITCH_CLIENTSECRET`

## Architecture Pivot — Itch Tag Search

### Why we pivoted

The original plan was jam themes → games. With only ~97 jam themes, the retrieval step couldn't match most user inputs ("gravity" had no jam theme match). We tried to expand by scraping hundreds more jams and extracting themes via LLM, but theme extraction didn't scale — too many jams announce themes as images or bury them in unclear descriptions.

### The new approach: itch.io tag-powered search

Itch.io has a curated tag system with 1,000+ tags across 16 pages at `https://itch.io/tags`. Any tag produces a browse page at `https://itch.io/games/tag-{slug}` with game listings. This is a pre-built, human-curated concept→games mapping. Developers self-tag their games, so data quality is high.

**The jam dataset doesn't disappear** — it becomes a secondary quality signal. But primary retrieval is now driven by itch tags.

### How itch.io tag browsing works

- **Tag index page**: `https://itch.io/tags` — 16 paginated pages listing all ~1,000+ curated tags
- **Tag browse page**: `https://itch.io/games/tag-{slug}` — lists games tagged with that concept
  - Supports pagination: `?page=2`, `?page=3`, etc.
  - Sort options: Popular (default), New & Popular, Top Rated, Top Sellers, Most Recent
    - URL patterns: `/games/tag-{slug}`, `/games/new-and-popular/tag-{slug}`, `/games/top-rated/tag-{slug}`, `/games/top-sellers/tag-{slug}`, `/games/newest/tag-{slug}`
  - Can combine tags: `/games/tag-gravity/tag-multiplayer`
  - Can filter by genre: `/games/genre-puzzle/tag-gravity`
  - Can filter to jam games only: `/games/in-jam/tag-gravity`
  - Can filter by platform: `/games/platform-web/tag-gravity`
  - Can filter by price: `/games/free/tag-gravity`
- **Game data available from browse page HTML** (no need to visit individual game pages):
  - Title
  - URL (e.g., `https://terrycavanagh.itch.io/vvvvvv`)
  - Cover image URL
  - Short description (one-liner)
  - Author name + URL
  - Genre label (e.g., "Platformer", "Puzzle")
  - Price (if any)
  - "Play in browser" indicator
- **RSS feeds**: append `.xml` to any browse URL for RSS (e.g., `/games/tag-gravity.xml`)
- **Related tags**: each tag page shows related/commonly-combined tags
- **Result count**: shown on the page (e.g., "2,884 results")

### Rate limiting considerations

- Itch.io has no public API for browse/search
- 1 req/sec (~1000ms delay) is safe; 2-3 req/sec occasionally triggers 429s
- Use a User-Agent header: `Mozilla/5.0 (compatible; JamPad/1.0)`
- Build-time scraping to populate local data is standard practice
- Runtime scraping on every user query is risky (speed, reliability, legal/ethical)
- **Recommended pattern**: scrape + cache with TTL, not live-on-every-request

## Current Task: Build Itch Tag Search System

Build a three-layer itch.io tag search system:

### Layer 1 — Tag Index (offline, refresh periodically)
Scrape all 16 pages of `https://itch.io/tags` to build a complete `slug → name` mapping of every valid itch.io tag. Store as `data/itch_tag_index.json`. This is the dictionary that the matcher validates against.

### Layer 2 — Tag Matcher (query time, no network calls)
Takes user theme input and finds relevant itch tags from the index:
- **Exact match**: "gravity" → `tag-gravity`
- **Fuzzy/substring match**: "time travel" → `tag-time-travel`
- **LLM decomposition** (for abstract themes like "everything is connected"): call LLM to suggest concrete tag candidates, then validate each against the index

### Layer 3 — Game Fetcher (query time, scrapes on-demand, caches)
For each matched tag, fetch the browse page, parse game listings, return lightweight results (title, URL, cover, description, author, genre). Cache results with configurable TTL so the same tag doesn't get re-scraped within the window.

### Pipeline flow
```
user theme → tag matcher → [tag1, tag2, tag3] → fetch games per tag → merge & deduplicate → return results
```

### Key principles
- No pre-scraped game data needed beyond the tag index
- Games only need: title, URL, cover image, short description, author, genre
- Users get redirected to itch.io game pages, so we don't need deep game details
- Cache aggressively, scrape conservatively
- The tag index is the only thing maintained offline; everything else is on-demand with caching
- Node.js + cheerio for scraping (consistent with existing codebase)
- Respect itch.io rate limits (1 req/sec minimum delay)

## Codebase Conventions

- **Node.js** for all scripts
- **`itch-scraper`** npm package for scraping individual game pages (`getGame()`) — used across `collect_jam_data.js`, `fill_details.js`, `fill_manual_games.js`, `fill_popular_games.js`
- **`itchy`** (TasfiqulTapu/Itchy) for jam metadata (`getJamData()`) — extracts jamID, jamType, etc.
- **cheerio** for HTML parsing of custom scrape targets (jam index pages, tag browse pages)
- Direct `fetch` + cheerio for endpoints not covered by the above packages (e.g., `results.json`, `entries.json`, tag browse pages)
- Scripts support `--dry-run` and `--resume` flags where applicable
- Incremental output writing with checkpoint/resume for long-running pipelines
- Low retry counts (1-2) with exponential backoff, paired with resume logic
- `p-limit` for concurrency control across all scripts
- Output stored in `data/` directory
- Scripts in `scripts/` directory