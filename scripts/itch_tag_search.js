/**
 * itch_tag_search.js  — Unified module
 *
 * Three-layer itch.io tag search system:
 *
 *   Layer 1 — Tag Index (offline, built by scrape_itch_tag_index.js)
 *             data/itch_tag_index.json: slug → name mapping
 *
 *   Layer 2 — Tag Matcher (itch_tag_matcher.js)
 *             Exact, fuzzy, and LLM-powered decomposition
 *
 *   Layer 3 — Game Fetcher (itch_game_fetcher.js)
 *             On-demand scraping with file-based cache
 *
 * Pipeline:
 *   user theme → matchTags() → [slug1, slug2, ...] → fetchMultiTagGames() → games
 *
 * Usage:
 *   const itchSearch = require("./itch_tag_search");
 *
 *   await itchSearch.init();
 *
 *   const { games, tags } = await itchSearch.findGames("everything is connected");
 *   // games: [{ title, url, cover, description, author, authorUrl, genre, browserPlayable, _tags }, ...]
 *   // tags:  [{ slug, name, score, strategy }, ...]
 *
 * Options to findGames():
 *   useLLM:       boolean  (default: true)   — use LLM for abstract themes
 *   maxTags:      number   (default: 6)       — max tags to match
 *   limitPerTag:  number   (default: 20)      — games fetched per tag
 *   limitTotal:   number   (default: 50)      — total games in result
 *   ttlMs:        number   (default: 86400000) — cache TTL (24h)
 *   sort:         string   (default: "popular") — see itch_game_fetcher for options
 *   noCache:      boolean  (default: false)   — bypass game cache
 *
 * You MUST call init() before findGames().
 * init() reads data/itch_tag_index.json from disk.
 * If the file doesn't exist, run: node scripts/scrape_itch_tag_index.js
 */

"use strict";

const matcher = require("./itch_tag_matcher");
const fetcher = require("./itch_game_fetcher");

// ─── State ────────────────────────────────────────────────────────────────────

let initialized = false;

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Load the tag index from disk.
 * Must be called once before findGames().
 *
 * @param {Object} [opts]
 * @param {string} [opts.tagIndexPath] — override default path to tag index JSON
 * @throws if data/itch_tag_index.json does not exist
 */
async function init(opts = {}) {
  await matcher.init(opts.tagIndexPath);
  initialized = true;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Full pipeline: theme → matched tags → fetched games.
 *
 * @param {string} theme — user's game jam theme
 * @param {Object} [opts]
 * @param {boolean} [opts.useLLM=true]        — use LLM for abstract themes
 * @param {number}  [opts.maxTags=6]          — max tag matches
 * @param {number}  [opts.limitPerTag=20]     — games per tag
 * @param {number}  [opts.limitTotal=50]      — total games returned
 * @param {number}  [opts.ttlMs=86400000]     — game cache TTL (ms)
 * @param {string}  [opts.sort="popular"]     — sort order
 * @param {boolean} [opts.noCache=false]      — bypass game cache
 * @param {number}  [opts.minFuzzyScore=0.3]  — min score for fuzzy matches
 *
 * @returns {Promise<{ games: Array, tags: Array }>}
 *   games — deduplicated, relevance-sorted game objects
 *   tags  — matched tags with slug, name, score, strategy
 */
async function findGames(theme, opts = {}) {
  if (!initialized) throw new Error("itch_tag_search not initialized. Call init() first.");

  const {
    useLLM       = true,
    maxTags      = 6,
    limitPerTag  = 20,
    limitTotal   = 50,
    ttlMs        = 24 * 3600 * 1000,
    sort         = "popular",
    noCache      = false,
    minFuzzyScore = 0.3,
  } = opts;

  // Layer 2: Match tags
  const matchedTags = await matcher.matchTags(theme, {
    useLLM,
    maxResults: maxTags,
    minFuzzyScore,
  });

  if (matchedTags.length === 0) {
    return { games: [], tags: [] };
  }

  const slugs = matchedTags.map(t => t.slug);

  // Enrich matched tags with human-readable names
  const tagsWithNames = matchedTags.map(t => ({
    ...t,
    name: matcher.getTagName(t.slug) || t.slug,
  }));

  // Layer 3: Fetch games
  const games = await fetcher.fetchMultiTagGames(slugs, {
    limitPerTag,
    limitTotal,
    ttlMs,
    sort,
    noCache,
  });

  return { games, tags: tagsWithNames };
}

// ─── Convenience exports ──────────────────────────────────────────────────────

/**
 * Fetch games for a single tag slug (bypasses the matcher).
 * Useful when you already know the slug.
 */
async function fetchByTag(slug, opts = {}) {
  return fetcher.fetchTagGames(slug, opts);
}

/**
 * Match tags without fetching games.
 * Useful for previewing what tags would be matched.
 */
async function matchOnly(theme, opts = {}) {
  if (!initialized) throw new Error("itch_tag_search not initialized. Call init() first.");

  const matchedTags = await matcher.matchTags(theme, opts);
  return matchedTags.map(t => ({
    ...t,
    name: matcher.getTagName(t.slug) || t.slug,
  }));
}

/**
 * Cache management helpers (passed through from fetcher).
 */
const cache = {
  stats:     fetcher.cacheStats,
  clear:     fetcher.clearCache,
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  findGames,
  fetchByTag,
  matchOnly,
  cache,
  // Expose sub-modules for advanced use
  matcher,
  fetcher,
};
