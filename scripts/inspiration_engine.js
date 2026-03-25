/**
 * inspiration_engine.js
 *
 * JamPad's Inspiration Engine — itch tag search pipeline.
 *
 * Pipeline:
 *   1. Tag match     (exact + fuzzy via itch_tag_matcher)
 *   2. LLM interpret (enrich tags, extract concepts, get IGDB terms)
 *   3. Parallel fetch (itch games + IGDB reference games)
 *   4. Jam fallback  (pull from local jam data if theme directly matches a jam)
 *   5. LLM narrate   (generate 3-5 inspiration paths)
 *
 * Usage:
 *   const engine = require("./inspiration_engine");
 *   await engine.init();
 *   const result = await engine.query({
 *     theme: "gravity",
 *     timeHours: 48,
 *     skillLevel: "intermediate",
 *     engine: "godot",
 *     genres: ["platformer", "puzzle"],
 *     dimensions: "2d",
 *     teamSize: "solo",
 *   });
 *
 * Environment:
 *   GEMINI_API_KEY       — required for LLM steps
 *   TWITCH_CLIENTID      — required for IGDB
 *   TWITCH_CLIENTSECRET  — required for IGDB
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const itchSearch = require("./itch_tag_search");
const matcher    = require("./itch_tag_matcher");
const fetcher    = require("./itch_game_fetcher");
const llm        = require("./llm_client");

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "../data");
const LOG      = process.env.ENGINE_LOG === "1";

// ─── State ────────────────────────────────────────────────────────────────────

let jamProfiles = null;   // game_profiles.json keyed by id (for jam fallback)
let jamCatalog  = null;   // theme_catalog.json (for jam theme matching)
let igdb        = null;   // igdb_client (optional)

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(opts = {}) {
  // Itch tag search (tag index + matcher + fetcher)
  await itchSearch.init();

  // Jam data — loaded for fallback only, failures are non-fatal
  try {
    jamProfiles = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "game_profiles.json"), "utf-8"));
    jamCatalog  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "theme_catalog.json"), "utf-8"));
    if (LOG) console.error(`[engine] Loaded ${Object.keys(jamProfiles).length} jam profiles`);
  } catch (err) {
    jamProfiles = null;
    jamCatalog  = null;
    if (LOG) console.error(`[engine] Jam data unavailable: ${err.message}`);
  }

  // IGDB client — optional
  if (!opts.skipIGDB) {
    try {
      igdb = require("./igdb_client");
      await igdb.init();
      if (LOG) console.error(`[engine] IGDB ready`);
    } catch (err) {
      igdb = null;
      if (LOG) console.error(`[engine] IGDB unavailable: ${err.message}`);
    }
  }
}

// ─── Step 1: Tag matching (exact + fuzzy, no LLM) ────────────────────────────

async function matchBaseTags(theme) {
  // Run exact + fuzzy only — LLM enrichment happens in a combined interpreter call
  return matcher.matchTags(theme, { useLLM: false, maxResults: 8 });
}

// ─── Step 2: LLM theme interpreter ───────────────────────────────────────────

const INTERPRETER_SYSTEM = `You are JamPad's theme interpreter for itch.io game jams. Given a game jam theme and a list of already-matched itch.io tag slugs, your job is to:
1. Suggest any additional itch.io tag/genre slugs from the vocabulary that the fuzzy matcher may have missed
2. Extract abstract creative concepts the theme evokes (used to guide the narrator)
3. Identify relevant IGDB genres and themes for finding commercial reference games

Only suggest tag slugs that appear verbatim in the provided vocabulary. Do not invent slugs.`;

async function interpretTheme(theme, baseTagSlugs, tagVocab) {
  if (!llm.status().ready) return { additional_tags: [], creative_concepts: [], igdb_genres: [], igdb_themes: [] };

  const vocabStr = Object.entries(tagVocab)
    .map(([key, { name }]) => `${key} (${name})`)
    .slice(0, 500)
    .join(", ");

  const alreadyMatched = baseTagSlugs.length
    ? `\nAlready matched: ${baseTagSlugs.join(", ")}`
    : "";

  try {
    return await llm.complete({
      system:      INTERPRETER_SYSTEM,
      user:        `Theme: "${theme}"${alreadyMatched}\n\nAvailable tag vocabulary:\n${vocabStr}`,
      schema:      llm.THEME_INTERPRETER_SCHEMA,
      quality:     "fast",
      temperature: 0.3,
    });
  } catch (err) {
    if (LOG) console.error(`[engine] Interpreter LLM failed: ${err.message}`);
    return { additional_tags: [], creative_concepts: [], igdb_genres: [], igdb_themes: [] };
  }
}

// ─── Step 3a: Fetch itch games ────────────────────────────────────────────────

async function fetchItchGames(slugs, dimensions, debug = false) {
  if (slugs.length === 0) return debug ? { games: [], perTag: {} } : [];

  // Prepend tag-2d / tag-3d as an extra search slug rather than combining
  // with every other slug — combined-tag URLs (e.g. /games/tag-gravity/tag-2d)
  // trigger Cloudflare 403; separate tag slugs do not.
  const fetchSlugs = [...slugs];
  if (dimensions === "2d" && !fetchSlugs.includes("tag-2d")) {
    fetchSlugs.unshift("tag-2d");
  } else if (dimensions === "3d" && !fetchSlugs.includes("tag-3d")) {
    fetchSlugs.unshift("tag-3d");
  }

  return fetcher.fetchMultiTagGames(fetchSlugs, {
    limitPerTag:  20,
    limitTotal:   50,
    returnPerTag: debug,
  });
}

// ─── Step 3b: Fetch IGDB references ──────────────────────────────────────────

async function fetchIGDBRefs(igdbGenres, igdbThemes) {
  if (!igdb) return [];
  try {
    return await igdb.findGames({
      genres:    igdbGenres,
      themes:    igdbThemes,
      minRating: 70,
      limit:     5,
    });
  } catch (err) {
    if (LOG) console.error(`[engine] IGDB fetch failed: ${err.message}`);
    return [];
  }
}

// ─── Step 4: Jam data fallback ────────────────────────────────────────────────

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function jamFallback(theme) {
  if (!jamProfiles || !jamCatalog) return [];

  const q = normalize(theme);

  // Only exact or very close matches qualify
  const matchedTheme = jamCatalog.jam_themes.find(t => {
    const tn = normalize(t);
    return tn === q || tn.includes(q) || q.includes(tn);
  });

  if (!matchedTheme) return [];

  if (LOG) console.error(`[engine] Jam fallback matched: "${matchedTheme}"`);

  return Object.values(jamProfiles)
    .filter(p => normalize(p.jamTheme) === normalize(matchedTheme))
    .sort((a, b) => (a.overallRank || 999) - (b.overallRank || 999))
    .slice(0, 8)
    .map(p => ({
      title:          p.title,
      url:            p.gameUrl,
      cover:          p.coverUrl || null,
      description:    p.description || null,
      author:         null,
      genre:          (p.genres || [])[0] || null,
      browserPlayable: false,
      _tags:          [matchedTheme],
      _source:        "jam",
    }));
}

// ─── Step 5: LLM narrator ────────────────────────────────────────────────────

const NARRATOR_SYSTEM = `You are JamPad's inspiration narrator for game jam participants. Given a theme, user constraints, and a pool of real games, create 3-5 distinct inspiration paths — each a meaningfully different creative direction a developer could take.

Rules:
- Only reference games from the provided itch.io and IGDB lists — do not invent games
- Each path must feel genuinely different from the others
- Scope advice must be realistic for the given time and skill level
- Keep pitches concrete and actionable, not vague or generic`;

function buildNarratorPrompt(theme, opts, itchGames, igdbGames, concepts) {
  const lines = [`Theme: "${theme}"`];
  if (opts.timeHours)   lines.push(`Time available: ${opts.timeHours} hours`);
  if (opts.skillLevel)  lines.push(`Skill level: ${opts.skillLevel}`);
  if (opts.engine)      lines.push(`Engine: ${opts.engine}`);
  if (opts.teamSize)    lines.push(`Team: ${opts.teamSize}`);
  if (opts.dimensions && opts.dimensions !== "either") lines.push(`Dimensions: ${opts.dimensions}`);
  if (opts.genres?.length) lines.push(`Preferred genres: ${opts.genres.join(", ")}`);
  if (concepts.length)  lines.push(`Creative concepts: ${concepts.join(", ")}`);

  lines.push("\nitch.io games (use these for example_games):");
  for (const g of itchGames.slice(0, 40)) {
    const tags = (g._tags || []).join(", ");
    lines.push(`  - "${g.title}" [${g.genre || "?"}] tags:${tags} ${g.url}`);
    if (g.description) lines.push(`    "${g.description.slice(0, 120)}"`);
  }

  if (igdbGames.length > 0) {
    lines.push("\nIGDB commercial references (use these for reference_games):");
    for (const g of igdbGames) {
      const genres = (g.genres || []).map(x => x.name || x).join(", ");
      lines.push(`  - "${g.name || g.title}" [${genres}] rating:${Math.round(g.rating || 0)}`);
      if (g.summary) lines.push(`    "${(g.summary || "").slice(0, 120)}"`);
    }
  }

  lines.push("\nGenerate 3-5 inspiration paths.");
  return lines.join("\n");
}

async function narratePaths(theme, opts, itchGames, igdbGames, concepts) {
  if (!llm.status().ready || itchGames.length === 0) {
    return fallbackNarrate(itchGames);
  }

  try {
    const result = await llm.complete({
      system:      NARRATOR_SYSTEM,
      user:        buildNarratorPrompt(theme, opts, itchGames, igdbGames, concepts),
      schema:      llm.NARRATOR_SCHEMA,
      quality:     "smart",
      temperature: 0.6,
    });
    return result.paths || [];
  } catch (err) {
    if (LOG) console.error(`[engine] Narrator LLM failed: ${err.message}`);
    return fallbackNarrate(itchGames);
  }
}

function fallbackNarrate(games) {
  // Group by genre, return one path per genre cluster
  const groups = {};
  for (const g of games) {
    const genre = g.genre || "Other";
    if (!groups[genre]) groups[genre] = [];
    groups[genre].push(g);
  }

  return Object.entries(groups).slice(0, 4).map(([genre, gs]) => ({
    name:          `${genre} approach`,
    pitch:         `Build a ${genre.toLowerCase()} game inspired by ${gs.length} jam entries.`,
    core_mechanic: "Implement the core loop first, polish later.",
    why_it_fits:   "Games with this genre tag matched the theme.",
    example_games: gs.slice(0, 2).map(g => ({ title: g.title, url: g.url, relevance: "Strong theme match" })),
    reference_games: [],
    scope_plan:    { first_hours: "Core mechanic", if_time_permits: "Polish + juice", cut_if_behind: "Any secondary mechanics" },
    art_direction: "Keep it simple and readable.",
    tone:          "Match the theme's energy.",
    title_ideas:   ["Jam Entry", "Theme Game"],
    jam_pitch:     `A ${genre.toLowerCase()} game built for the jam.`,
  }));
}

// ─── Main query ───────────────────────────────────────────────────────────────

/**
 * Run the full pipeline.
 *
 * @param {Object} opts
 * @param {string}   opts.theme       — jam theme (required)
 * @param {number}   [opts.timeHours] — available hours
 * @param {string}   [opts.skillLevel]
 * @param {string}   [opts.engine]
 * @param {string[]} [opts.genres]
 * @param {string}   [opts.dimensions] — "2d" | "3d" | "either"
 * @param {string}   [opts.teamSize]
 *
 * @returns {{ paths, meta }}
 */
async function query(opts) {
  if (!opts?.theme) throw new Error("opts.theme is required");
  const t0 = Date.now();

  // 1. Base tag matching (exact + fuzzy, no LLM)
  const baseTags  = await matchBaseTags(opts.theme);
  const baseSlugs = baseTags.map(t => t.slug);
  if (LOG) console.error(`[engine] Base tags: ${baseSlugs.join(", ") || "(none)"}`);

  // 2. LLM theme interpreter (enriches tags + extracts IGDB terms + concepts)
  const tagVocab   = matcher.getIndex() || {};
  const interpreted = await interpretTheme(opts.theme, baseSlugs, tagVocab);

  // Validate LLM-suggested tags against the index
  const llmTags = (interpreted.additional_tags || [])
    .filter(slug => tagVocab[slug])
    .map(slug => ({ slug, score: 0.7, strategy: "llm" }));

  // Merge: base tags first, append LLM additions not already present
  const seenSlugs = new Set(baseSlugs);
  const mergedTags = [...baseTags];
  for (const t of llmTags) {
    if (!seenSlugs.has(t.slug)) { mergedTags.push(t); seenSlugs.add(t.slug); }
  }

  const finalSlugs = mergedTags.slice(0, 8).map(t => t.slug);
  if (LOG) console.error(`[engine] Final tags: ${finalSlugs.join(", ")}`);
  if (LOG) console.error(`[engine] Concepts: ${(interpreted.creative_concepts || []).join(", ")}`);

  const debug = !!opts.debug;

  // 3. Parallel: fetch itch games + IGDB refs + jam fallback
  const [itchResult, igdbRaw, jamGames] = await Promise.all([
    fetchItchGames(finalSlugs, opts.dimensions, debug),
    fetchIGDBRefs(interpreted.igdb_genres || [], interpreted.igdb_themes || []),
    Promise.resolve(jamFallback(opts.theme)),
  ]);

  const itchGames = debug ? itchResult.games : itchResult;
  const itchPerTag = debug ? itchResult.perTag : null;

  if (LOG) console.error(`[engine] Itch: ${itchGames.length}, IGDB: ${igdbRaw.length}, Jam fallback: ${jamGames.length}`);

  // Merge jam fallback games (deduplicate by URL)
  const seenUrls = new Set(itchGames.map(g => g.url));
  const allItchGames = [...itchGames];
  for (const g of jamGames) {
    if (g.url && !seenUrls.has(g.url)) { allItchGames.push(g); seenUrls.add(g.url); }
  }

  // 4. Narrate paths
  const paths = await narratePaths(
    opts.theme, opts, allItchGames, igdbRaw, interpreted.creative_concepts || []
  );

  const meta = {
    theme:          opts.theme,
    tags:           mergedTags.map(t => ({ slug: t.slug, score: t.score, strategy: t.strategy })),
    concepts:       interpreted.creative_concepts || [],
    igdbGenres:     interpreted.igdb_genres || [],
    igdbThemes:     interpreted.igdb_themes || [],
    itchCount:      itchGames.length,
    jamCount:       jamGames.length,
    igdbCount:      igdbRaw.length,
    igdbGames:      igdbRaw.map(g => ({ title: g.name || g.title, rating: Math.round(g.rating || 0) })),
    pathCount:      paths.length,
    llmAvailable:   llm.status().ready,
    queryTimeMs:    Date.now() - t0,
  };

  if (debug) {
    meta.debug = {
      itchPerTag,
      igdbQuery: {
        genres: interpreted.igdb_genres || [],
        themes: interpreted.igdb_themes || [],
        minRating: 70,
      },
      igdbFull: igdbRaw.map(g => ({
        title:    g.name || g.title,
        rating:   Math.round(g.rating || 0),
        genres:   (g.genres  || []).map(x => x.name || x),
        themes:   (g.themes  || []).map(x => x.name || x),
        summary:  g.summary ? g.summary.slice(0, 200) : null,
        url:      g.url || null,
      })),
    };
  }

  return { paths, meta };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { init, query };
