/**
 * igdb_client.js
 *
 * Reusable IGDB API client for JamPad's Inspiration Engine.
 * Handles Twitch OAuth token management, rate limiting, and provides
 * high-level query helpers for finding reference games.
 *
 * Usage:
 *   const igdb = require("./igdb_client");
 *
 *   await igdb.init();  // authenticates, loads taxonomies + mapping
 *
 *   // Find games by genre + theme
 *   const games = await igdb.findGames({
 *     genres: ["Puzzle"],        // itch genre names
 *     themes: ["Horror"],        // itch tag names (mapped to IGDB themes)
 *     perspectives: ["2D"],      // itch tags like "2D", "3D", "First-Person"
 *     engines: ["Unity"],        // itch "Made with" values
 *     minRating: 70,
 *     limit: 5,
 *   });
 *
 *   // Search by name
 *   const celeste = await igdb.searchGame("Celeste");
 *
 *   // Build image URLs
 *   const coverUrl = igdb.imageUrl("co1rba", "cover_big");
 *   const screenshotUrl = igdb.imageUrl("sc6k4f", "screenshot_big");
 */

"use strict";

const fs   = require("fs/promises");
const path = require("path");

// ─── Load .env ────────────────────────────────────────────────────────────────

try {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
} catch {
  // dotenv not installed — fall back to process.env
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.TWITCH_CLIENTID;
const CLIENT_SECRET = process.env.TWITCH_CLIENTSECRET;
const IGDB_BASE     = "https://api.igdb.com/v4";
const AUTH_URL      = "https://id.twitch.tv/oauth2/token";

const TAXONOMY_FILE = path.resolve(__dirname, "../data/igdb_taxonomies.json");
const MAPPING_FILE  = path.resolve(__dirname, "../data/itch_to_igdb_map.json");

// Rate limiting: IGDB allows 4 req/sec. We stay conservative.
const MIN_REQUEST_INTERVAL = 280; // ms between requests
let lastRequestTime = 0;

// Token state
let accessToken = null;
let tokenExpiresAt = 0;

// Loaded data
let taxonomies = null;
let itchMapping = null;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function authenticate() {
  const url = `${AUTH_URL}?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`IGDB auth failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  accessToken = data.access_token;
  // Refresh 5 minutes before actual expiry
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
}

async function ensureAuth() {
  if (!accessToken || Date.now() >= tokenExpiresAt) {
    await authenticate();
  }
}

// ─── Rate-limited fetch ───────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function igdbFetch(endpoint, body) {
  await ensureAuth();

  // Enforce minimum interval between requests
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - elapsed);
  }

  const res = await fetch(`${IGDB_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Client-ID": CLIENT_ID,
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
    },
    body,
  });

  lastRequestTime = Date.now();

  if (res.status === 429) {
    // Back off and retry once
    await sleep(2000);
    return igdbFetch(endpoint, body);
  }

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`IGDB ${endpoint} error (${res.status}): ${errBody}`);
  }

  return res.json();
}

// ─── Image URL helper ─────────────────────────────────────────────────────────

/**
 * Build an IGDB image CDN URL from an image_id and size.
 *
 * Sizes:
 *   cover_small  (90x128)   cover_big     (227x320)
 *   screenshot_med (569x320) screenshot_big (889x500) screenshot_huge (1280x720)
 *   thumb (90x90)  720p (1280x720)  1080p (1920x1080)
 *
 * Append _2x to any size for retina (e.g. "cover_big_2x").
 */
function imageUrl(imageId, size = "cover_big") {
  return `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`;
}

// ─── Taxonomy / mapping helpers ───────────────────────────────────────────────

/**
 * Translate an itch.io term (genre, tag, or engine) to IGDB IDs using the mapping.
 * Returns { igdb_type, igdb_id, igdb_name } or null.
 */
function resolveItchTerm(term, source = "tag") {
  if (!itchMapping) return null;

  const section = source === "genre" ? itchMapping.genres
                : source === "engine" ? itchMapping.engines
                : itchMapping.tags;

  return section[term] ?? null;
}

/**
 * Given an array of itch terms and a target IGDB type, return the IGDB IDs.
 * Example: resolveIds(["Puzzle", "Action"], "genre") → [9, 25]
 */
function resolveIds(terms, targetType, source = "tag") {
  const ids = [];
  for (const term of terms) {
    const resolved = resolveItchTerm(term, source);
    if (resolved && resolved.igdb_type === targetType && resolved.igdb_id) {
      ids.push(resolved.igdb_id);
    }
  }
  return [...new Set(ids)];
}

// ─── High-level query helpers ─────────────────────────────────────────────────

/**
 * Find games matching a combination of genres, themes, perspectives, etc.
 * All parameters use itch.io terminology — the mapping handles translation.
 *
 * Options:
 *   genres:       string[]   itch genre names (e.g. ["Puzzle", "Platformer"])
 *   themes:       string[]   itch tag/theme names (e.g. ["Horror", "Comedy"])
 *   keywords:     string[]   itch tag names mapped to IGDB keywords
 *   perspectives: string[]   itch tags like "2D", "3D", "First-Person"
 *   engines:      string[]   itch "Made with" values
 *   minRating:    number     minimum IGDB rating (0-100), default 60
 *   limit:        number     max results, default 10
 *   excludeErotic: boolean   filter out erotic theme (42), default true
 */
async function findGames(options = {}) {
  const {
    genres = [],
    themes = [],
    keywords = [],
    perspectives = [],
    engines = [],
    minRating = 60,
    limit = 10,
    excludeErotic = true,
  } = options;

  // Resolve itch terms → IGDB IDs
  const genreIds       = resolveIds(genres, "genre", "genre");
  const themeIds       = resolveIds(themes, "theme", "tag");
  const keywordIds     = resolveIds(keywords, "keyword", "tag");
  const perspectiveIds = resolveIds(perspectives, "perspective", "tag");

  // Build where clauses
  const wheres = [];

  // Exclude editions/re-releases/DLC. version_parent = null means "this is an
  // original game, not a variant of another". More reliable than category = 0
  // which returns empty results when combined with other filters.
  wheres.push("version_parent = null");

  if (genreIds.length > 0)       wheres.push(`genres = (${genreIds.join(",")})`);
  if (themeIds.length > 0)       wheres.push(`themes = (${themeIds.join(",")})`);
  if (keywordIds.length > 0)     wheres.push(`keywords = (${keywordIds.join(",")})`);
  if (perspectiveIds.length > 0) wheres.push(`player_perspectives = (${perspectiveIds.join(",")})`);
  if (minRating > 0)             wheres.push(`rating >= ${minRating}`);
  if (excludeErotic)             wheres.push("themes != (42)");

  const fields = [
    "name", "slug", "summary", "url",
    "rating", "rating_count",
    "genres.name", "themes.name", "keywords.name",
    "player_perspectives.name", "game_modes.name",
    "cover.image_id", "screenshots.image_id",
    "artworks.image_id",
    "first_release_date",
    "game_engines.name",
  ].join(",");

  const body = [
    `fields ${fields};`,
    `where ${wheres.join(" & ")};`,
    `sort rating desc;`,
    `limit ${limit};`,
  ].join("\n");

  const results = await igdbFetch("games", body);

  // Enrich with image URLs
  return results.map(game => ({
    ...game,
    _images: {
      cover: game.cover?.image_id ? imageUrl(game.cover.image_id, "cover_big") : null,
      cover_small: game.cover?.image_id ? imageUrl(game.cover.image_id, "cover_small") : null,
      screenshots: (game.screenshots ?? []).slice(0, 3).map(s =>
        imageUrl(s.image_id, "screenshot_big")
      ),
      artwork: (game.artworks ?? []).slice(0, 1).map(a =>
        imageUrl(a.image_id, "screenshot_big")
      )[0] ?? null,
    },
  }));
}

/**
 * Search IGDB for a game by name. Useful when the LLM references a specific
 * commercial game (e.g. "like Celeste but with time mechanics").
 */
async function searchGame(name, limit = 5) {
  const fields = [
    "name", "slug", "summary", "url",
    "rating", "rating_count",
    "genres.name", "themes.name",
    "cover.image_id", "screenshots.image_id",
    "first_release_date",
  ].join(",");

  const body = [
    `search "${name.replace(/"/g, '\\"')}";`,
    `fields ${fields};`,
    `where version_parent = null & themes != (42);`,
    `limit ${limit};`,
  ].join("\n");

  const results = await igdbFetch("games", body);

  return results.map(game => ({
    ...game,
    _images: {
      cover: game.cover?.image_id ? imageUrl(game.cover.image_id, "cover_big") : null,
      screenshots: (game.screenshots ?? []).slice(0, 3).map(s =>
        imageUrl(s.image_id, "screenshot_big")
      ),
    },
  }));
}

/**
 * Get full details for a single game by IGDB ID.
 */
async function getGame(id) {
  const fields = [
    "name", "slug", "summary", "storyline", "url",
    "rating", "rating_count", "total_rating", "total_rating_count",
    "genres.name", "themes.name", "keywords.name",
    "player_perspectives.name", "game_modes.name",
    "cover.image_id", "screenshots.image_id", "artworks.image_id",
    "first_release_date",
    "game_engines.name",
    "involved_companies.company.name",
    "involved_companies.developer",
    "platforms.name",
    "similar_games",
  ].join(",");

  const body = `fields ${fields};\nwhere id = ${id};`;
  const results = await igdbFetch("games", body);

  if (results.length === 0) return null;

  const game = results[0];
  return {
    ...game,
    _images: {
      cover: game.cover?.image_id ? imageUrl(game.cover.image_id, "cover_big") : null,
      screenshots: (game.screenshots ?? []).slice(0, 5).map(s =>
        imageUrl(s.image_id, "screenshot_big")
      ),
      artworks: (game.artworks ?? []).map(a =>
        imageUrl(a.image_id, "1080p")
      ),
    },
  };
}

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Must be called once before using any query functions.
 * Authenticates with Twitch and loads local taxonomy/mapping data.
 */
async function init() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing TWITCH_CLIENTID or TWITCH_CLIENTSECRET in environment");
  }

  // Load local data
  taxonomies = JSON.parse(await fs.readFile(TAXONOMY_FILE, "utf-8"));
  itchMapping = JSON.parse(await fs.readFile(MAPPING_FILE, "utf-8"));

  // Authenticate
  await authenticate();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  findGames,
  searchGame,
  getGame,
  imageUrl,
  resolveItchTerm,
  resolveIds,
  igdbFetch,
  getTaxonomies: () => taxonomies,
  getMapping: () => itchMapping,
};