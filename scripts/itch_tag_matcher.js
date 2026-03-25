/**
 * itch_tag_matcher.js  — Layer 2
 *
 * Takes a user theme string and finds relevant itch.io tag keys from the
 * local tag index (data/itch_tag_index.json).
 *
 * Index format (post-multi-category scrape):
 *   { "tag-gravity": { name: "Gravity", category: "tags" },
 *     "genre-visual-novel": { name: "Visual Novel", category: "genres" }, ... }
 *
 * The key is the URL path segment used in browse URLs:
 *   https://itch.io/games/{key}
 *
 * Three matching strategies (applied in order, results merged):
 *   1. Exact match   — "gravity" → key "tag-gravity"
 *   2. Fuzzy/substr  — "time travel" → "tag-time-travel"
 *                      "horror" matches "tag-psychological-horror", etc.
 *   3. LLM decompose — abstract themes → LLM suggests slugs → validated against index
 *
 * Usage:
 *   const matcher = require("./itch_tag_matcher");
 *   await matcher.init();
 *   const matches = await matcher.matchTags("everything is connected");
 *   // → [{ slug: "tag-connection", score: 0.9, strategy: "fuzzy", name: "Connection" }, ...]
 *
 * Options:
 *   useLLM:       boolean  (default: true)
 *   maxResults:   number   (default: 6)
 *   minScore:     number   (default: 0.3)
 */

"use strict";

const fs   = require("fs/promises");
const path = require("path");

const TAG_INDEX_FILE = path.resolve(__dirname, "../data/itch_tag_index.json");

// ─── State ────────────────────────────────────────────────────────────────────

let tagIndex   = null;   // key → { name, category }
let tagEntries = null;   // [{ key, name, category, slugPart, words }]

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Load the tag index from disk.
 * Must be called before matchTags().
 */
async function init(indexPath) {
  const raw = await fs.readFile(indexPath || TAG_INDEX_FILE, "utf-8");
  tagIndex = JSON.parse(raw);

  tagEntries = Object.entries(tagIndex).map(([key, { name, category }]) => {
    // Strip the type prefix to get the matchable slug part:
    //   "tag-gravity"        → slugPart "gravity"
    //   "genre-visual-novel" → slugPart "visual-novel"
    const slugPart = key.replace(/^(tag|genre)-/, "");
    return {
      key,
      name,
      category,
      slugPart,
      normalized: slugPart.replace(/-/g, " "),
      words: slugPart.split("-"),
    };
  });
}

function isReady() {
  return tagIndex !== null;
}

// ─── Normalization ────────────────────────────────────────────────────────────

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function themeToSlugPart(theme) {
  return normalize(theme).replace(/\s+/g, "-");
}

// ─── Strategy 1: Exact match ──────────────────────────────────────────────────

function exactMatch(theme) {
  const slugPart = themeToSlugPart(theme);

  // Try "tag-{slugPart}" first, then "genre-{slugPart}"
  for (const prefix of ["tag", "genre"]) {
    const key = `${prefix}-${slugPart}`;
    if (tagIndex[key]) return [{ slug: key, score: 1.0, strategy: "exact" }];
  }

  return [];
}

// ─── Strategy 2: Fuzzy / substring matching ───────────────────────────────────

function fuzzyScore(entry, themeWords) {
  const themePhrase = themeWords.join(" ");

  if (entry.normalized === themePhrase) return 1.0;
  if (entry.normalized.includes(themePhrase)) return 0.85;
  if (themePhrase.includes(entry.normalized)) return 0.80;

  const themeSet = new Set(themeWords);
  const tagSet   = new Set(entry.words);
  const intersection = [...themeSet].filter(w => tagSet.has(w)).length;
  if (intersection === 0) return 0;

  const tagCoverage   = intersection / tagSet.size;
  const themeCoverage = intersection / themeSet.size;
  return tagCoverage * 0.6 + themeCoverage * 0.4;
}

function fuzzyMatch(theme, maxResults = 10, minScore = 0.3) {
  const themeWords = normalize(theme).split(/\s+/).filter(Boolean);
  if (themeWords.length === 0) return [];

  const scored = [];
  for (const entry of tagEntries) {
    const score = fuzzyScore(entry, themeWords);
    if (score >= minScore) {
      scored.push({ slug: entry.key, score, strategy: "fuzzy" });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

// ─── Strategy 3: LLM decomposition ───────────────────────────────────────────

const LLM_SCHEMA = {
  type: "object",
  properties: {
    candidate_slugs: {
      type: "array",
      description: "5-10 itch.io tag or genre keys (e.g. 'tag-gravity', 'genre-puzzle') that relate to the theme. Only suggest keys that exist in the provided vocabulary.",
      items: { type: "string" },
    },
    reasoning: {
      type: "string",
      description: "One sentence explaining how you interpreted the theme.",
    },
  },
  required: ["candidate_slugs", "reasoning"],
};

async function llmDecompose(theme) {
  const llm = require("./llm_client");

  // Provide the full key list as grounding vocabulary
  const vocab = Object.entries(tagIndex)
    .map(([key, { name }]) => `${key} (${name})`)
    .slice(0, 500)
    .join(", ");

  const result = await llm.complete({
    system: `You are a game tag expert for itch.io. Given a game jam theme, identify relevant itch.io tags and genres from the provided vocabulary that game developers might use for games built around this theme. Only suggest keys that appear verbatim in the vocabulary.`,
    user: `Theme: "${theme}"\n\nAvailable keys (key (Display Name)):\n${vocab}\n\nSuggest 5-10 keys from the vocabulary that relate to this theme.`,
    schema:  LLM_SCHEMA,
    quality: "fast",
    temperature: 0.3,
  }).catch(err => {
    console.warn(`[matcher] LLM call failed: ${err.message}`);
    return null;
  });

  if (!result) return [];

  return (result.candidate_slugs || [])
    .map(c => c.toLowerCase().trim())
    .filter(key => tagIndex[key])
    .map(key => ({ slug: key, score: 0.7, strategy: "llm" }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Match a user theme to itch.io tag/genre keys.
 *
 * @param {string} theme
 * @param {Object} [opts]
 * @param {boolean} [opts.useLLM=true]
 * @param {number}  [opts.maxResults=6]
 * @param {number}  [opts.minFuzzyScore=0.3]
 *
 * @returns {Promise<Array<{ slug: string, score: number, strategy: string }>>}
 *   slug is the full key, e.g. "tag-gravity" or "genre-puzzle"
 */
async function matchTags(theme, opts = {}) {
  if (!tagIndex) throw new Error("Tag matcher not initialized. Call init() first.");

  const { useLLM = true, maxResults = 6, minFuzzyScore = 0.3 } = opts;

  const seen    = new Set();
  const results = [];

  function add(match) {
    if (!seen.has(match.slug)) {
      seen.add(match.slug);
      results.push(match);
    }
  }

  for (const m of exactMatch(theme)) add(m);
  for (const m of fuzzyMatch(theme, 15, minFuzzyScore)) add(m);

  const themeWords = normalize(theme).split(/\s+/).filter(Boolean);
  if (useLLM && (themeWords.length > 1 || results.length < 2)) {
    for (const m of await llmDecompose(theme)) add(m);
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function getTagName(key) {
  return tagIndex?.[key]?.name ?? null;
}

function getTagCategory(key) {
  return tagIndex?.[key]?.category ?? null;
}

function hasTag(key) {
  return !!tagIndex?.[key];
}

function getIndex() {
  return tagIndex;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  isReady,
  matchTags,
  getTagName,
  getTagCategory,
  hasTag,
  getIndex,
};
