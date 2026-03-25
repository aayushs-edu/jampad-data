/**
 * itch_game_fetcher.js  — Layer 3
 *
 * Fetches game listings from itch.io tag browse pages on demand,
 * with a file-based cache to avoid re-scraping within a TTL window.
 *
 * For each tag slug, fetches: https://itch.io/games/tag-{slug}
 * Parses game cards to extract: title, url, cover, description, author, genre.
 *
 * Cache layout:
 *   data/cache/itch_tags/{slug}.json
 *   { fetchedAt: ISO, games: [...] }
 *
 * Usage:
 *   const fetcher = require("./itch_game_fetcher");
 *
 *   const games = await fetcher.fetchTagGames("gravity");
 *   // → [{ title, url, cover, description, author, authorUrl, genre, browserPlayable }, ...]
 *
 *   // With options
 *   const games = await fetcher.fetchTagGames("puzzle", {
 *     ttlMs:    6 * 3600 * 1000,  // 6-hour cache (default: 24h)
 *     limit:    20,                // max games per tag (default: 30)
 *     sort:     "popular",         // "popular" | "new-and-popular" | "top-rated" | "most-recent"
 *   });
 */

"use strict";

const fs      = require("fs/promises");
const path    = require("path");
const https   = require("https");
const cheerio = require("cheerio");

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_DIR    = path.resolve(__dirname, "../data/cache/itch_tags");
const USER_AGENT   = "Mozilla/5.0 (compatible; JamPad/1.0)";
const REQUEST_DELAY = 1100;  // ms between network requests
const MAX_RETRIES   = 2;
const RETRY_BASE    = 8000;  // ms, doubles per retry

const DEFAULT_TTL   = 24 * 3600 * 1000;  // 24 hours
const DEFAULT_LIMIT = 30;

// Build a browse URL from a key (e.g. "tag-gravity", "genre-visual-novel") and sort order.
// The key is the URL path segment: https://itch.io/games/{key}
// Sort variants insert a segment after /games/: /games/new-and-popular/{key}
function buildBrowseUrl(key, sort = "popular") {
  const sortSegment = {
    "new-and-popular": "new-and-popular",
    "top-rated":       "top-rated",
    "most-recent":     "newest",
  }[sort];
  return sortSegment
    ? `https://itch.io/games/${sortSegment}/${key}`
    : `https://itch.io/games/${key}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchHTML(url, retries = 0) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      agent: new https.Agent({ keepAlive: true }),
    });

    if (res.status === 429 || res.status >= 500) {
      if (retries >= MAX_RETRIES) {
        throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries: ${url}`);
      }
      const delay = RETRY_BASE * Math.pow(2, retries);
      console.warn(`  [fetcher] ⏳ ${res.status} — waiting ${delay / 1000}s (retry ${retries + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return fetchHTML(url, retries + 1);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${url}`);
    }

    return res.text();
  } finally {
    await sleep(REQUEST_DELAY);
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function cacheFile(slug) {
  // Replace slashes (used in combined tag URLs like "tag-gravity/tag-2d") with "+"
  return path.join(CACHE_DIR, `${slug.replace(/\//g, "+")}.json`);
}

async function readCache(slug, ttlMs) {
  try {
    const raw  = await fs.readFile(cacheFile(slug), "utf-8");
    const data = JSON.parse(raw);
    const age  = Date.now() - new Date(data.fetchedAt).getTime();
    if (age < ttlMs) return data.games;
  } catch {
    // Cache miss or parse error — fall through
  }
  return null;
}

async function writeCache(slug, games) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const data = { fetchedAt: new Date().toISOString(), games };
  await fs.writeFile(cacheFile(slug), JSON.stringify(data, null, 2), "utf-8");
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────

/**
 * Parse game cards from an itch.io browse page.
 *
 * Confirmed live HTML structure (itch.io/games/tag-*):
 *
 *   <div class="game_cell has_cover lazy_images">
 *     <div class="game_thumb">
 *       <a class="thumb_link game_link" href="https://user.itch.io/game">
 *         <img data-lazy_src="https://img.itch.zone/..."/>
 *       </a>
 *     </div>
 *     <div class="game_cell_data">
 *       <div class="game_title">
 *         <a class="title game_link" href="https://user.itch.io/game">Title</a>
 *         <div class="price_tag"><div class="price_value">$4.99</div></div>
 *       </div>
 *       <div class="game_text" title="description">Short description</div>
 *       <div class="game_author"><a href="https://user.itch.io">Author</a></div>
 *       <div class="game_genre">Platformer</div>
 *       <div class="game_platform">
 *         <span class="web_flag">Play in browser</span>   ← only if browser-playable
 *         <span class="icon icon-windows8">...</span>
 *       </div>
 *     </div>
 *   </div>
 *
 * NOTE: .game_thumb is a CHILD of .game_cell, not a sibling — don't select both.
 */
function parseGameListing(html) {
  const $ = cheerio.load(html);
  const games = [];

  $(".game_cell").each((_, el) => {
    const $cell = $(el);

    // Title + URL: the .title link inside .game_title
    const $titleLink = $cell.find(".game_title a.title").first();
    const title = $titleLink.text().trim();
    const url   = $titleLink.attr("href") || "";

    if (!title || !url) return;

    // URLs are absolute (https://user.itch.io/game), but guard for relative
    const gameUrl = url.startsWith("http") ? url : `https://itch.io${url}`;

    // Cover image: lazy-loaded thumbnail in .game_thumb
    const $img = $cell.find(".game_thumb img").first();
    const cover = $img.attr("data-lazy_src")
               || $img.attr("src")
               || null;

    // Short description (also in title attribute for truncated text)
    const $desc = $cell.find(".game_text").first();
    const description = ($desc.attr("title") || $desc.text()).trim() || null;

    // Author: first <a> inside .game_author (the SVG badge is not an <a>)
    const $authorLink = $cell.find(".game_author a").first();
    const author      = $authorLink.text().trim() || null;
    const authorUrl   = $authorLink.attr("href") || null;

    // Genre
    const genre = $cell.find(".game_genre").first().text().trim() || null;

    // "Play in browser" indicator
    const browserPlayable = $cell.find(".web_flag").length > 0;

    games.push({
      title,
      url:             gameUrl,
      cover:           cover || null,
      description:     description || null,
      author:          author || null,
      authorUrl:       authorUrl || null,
      genre:           genre || null,
      browserPlayable,
    });
  });

  return games;
}

// ─── Result count parsing ─────────────────────────────────────────────────────

/**
 * Extract the number of games for a tag from the page (e.g. "2,884 results").
 */
function parseResultCount(html) {
  const match = html.match(/([\d,]+)\s+results?/i);
  return match ? parseInt(match[1].replace(/,/g, "")) : null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch games for a single itch.io tag slug.
 *
 * @param {string} key     — index key, e.g. "tag-gravity", "genre-visual-novel"
 * @param {Object} [opts]
 * @param {number}  [opts.ttlMs=86400000] — cache TTL in ms (default: 24h)
 * @param {number}  [opts.limit=30]       — max games to return
 * @param {string}  [opts.sort="popular"] — sort order
 * @param {boolean} [opts.noCache=false]  — bypass cache, always re-fetch
 *
 * @returns {Promise<Array>} — array of game objects
 */
async function fetchTagGames(key, opts = {}) {
  const slug = key; // alias — variable reuse below
  const {
    ttlMs   = DEFAULT_TTL,
    limit   = DEFAULT_LIMIT,
    sort    = "popular",
    noCache = false,
  } = opts;

  // Check cache first
  if (!noCache) {
    const cached = await readCache(slug, ttlMs);
    if (cached) {
      return cached.slice(0, limit);
    }
  }

  // Build URL
  const url = buildBrowseUrl(slug, sort);

  let html;
  try {
    html = await fetchHTML(url);
  } catch (err) {
    console.warn(`[fetcher] Failed to fetch tag "${slug}": ${err.message}`);
    return [];
  }

  const games = parseGameListing(html);

  // Cache the full result set (before limit), so callers can request different limits
  if (games.length > 0) {
    await writeCache(slug, games).catch(err => {
      console.warn(`[fetcher] Cache write failed for "${slug}": ${err.message}`);
    });
  }

  return games.slice(0, limit);
}

/**
 * Fetch games for multiple tag slugs, merging and deduplicating results.
 *
 * Games appearing under multiple tags get a relevance boost.
 * Results are sorted by: (tag overlap count DESC, then appearance order).
 *
 * @param {string[]} slugs      — array of tag slugs
 * @param {Object}   [opts]     — same options as fetchTagGames, plus:
 * @param {number}   [opts.limitPerTag=20]  — games fetched per tag
 * @param {number}   [opts.limitTotal=50]   — total games returned
 *
 * @returns {Promise<Array>} — deduplicated, relevance-sorted game objects
 *                             each with added `_tags: string[]` field
 */
async function fetchMultiTagGames(slugs, opts = {}) {
  const {
    limitPerTag  = 20,
    limitTotal   = 50,
    ttlMs        = DEFAULT_TTL,
    sort         = "popular",
    noCache      = false,
    returnPerTag = false,
  } = opts;

  // Fetch each tag serially (respect rate limits)
  const byUrl    = new Map();   // url → { game, tags: Set }
  const perTag   = {};          // slug → { total, games: [{title,url}] }

  for (const slug of slugs) {
    const games = await fetchTagGames(slug, { ttlMs, limit: limitPerTag, sort, noCache });

    if (returnPerTag) {
      perTag[slug] = {
        total: games.length,
        games: games.map(g => ({ title: g.title, url: g.url, genre: g.genre })),
      };
    }

    for (const game of games) {
      const key = game.url;
      if (byUrl.has(key)) {
        byUrl.get(key).tags.add(slug);
      } else {
        byUrl.set(key, { game: { ...game }, tags: new Set([slug]) });
      }
    }
  }

  // Sort by tag overlap (games in multiple tags are more relevant), then insertion order
  const entries = [...byUrl.values()];
  entries.sort((a, b) => b.tags.size - a.tags.size);

  const merged = entries.slice(0, limitTotal).map(({ game, tags }) => ({
    ...game,
    _tags: [...tags],
  }));

  if (returnPerTag) return { games: merged, perTag };
  return merged;
}

/**
 * Bust the cache for a specific slug (or all slugs).
 *
 * @param {string} [slug] — if omitted, clears all tag caches
 */
async function clearCache(slug) {
  if (slug) {
    try {
      await fs.unlink(cacheFile(slug));
    } catch { /* already gone */ }
    return;
  }

  try {
    const files = await fs.readdir(CACHE_DIR);
    await Promise.all(files.map(f => fs.unlink(path.join(CACHE_DIR, f)).catch(() => {})));
  } catch { /* dir doesn't exist */ }
}

/**
 * Return cache stats: how many tags are cached, oldest/newest entry.
 */
async function cacheStats() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    if (files.length === 0) return { count: 0 };

    let oldest = Infinity, newest = 0;
    let totalGames = 0;

    for (const file of files) {
      try {
        const raw  = await fs.readFile(path.join(CACHE_DIR, file), "utf-8");
        const data = JSON.parse(raw);
        const ts   = new Date(data.fetchedAt).getTime();
        if (ts < oldest) oldest = ts;
        if (ts > newest) newest = ts;
        totalGames += data.games?.length ?? 0;
      } catch { /* skip */ }
    }

    return {
      count:      files.length,
      totalGames,
      oldestAge:  Math.round((Date.now() - oldest) / 3600000) + "h",
      newestAge:  Math.round((Date.now() - newest) / 3600000) + "h",
    };
  } catch {
    return { count: 0 };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fetchTagGames,
  fetchMultiTagGames,
  clearCache,
  cacheStats,
};
