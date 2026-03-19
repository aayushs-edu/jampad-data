/**
 * build_inverted_index.js
 *
 * Reads data/jam_data.json (or a path passed as argv[1]) and produces:
 *
 *   data/inverted_index.json
 *     Term → game ID lists, bucketed by facet type.
 *     Used at runtime for fast retrieval when the LLM returns concept tags.
 *
 *   data/game_profiles.json
 *     Game ID → compact profile with every field the runtime needs to
 *     score, filter, and display a result card.
 *
 * No LLM calls. No network. Pure deterministic code over existing metadata.
 *
 * Usage:
 *   node scripts/build_inverted_index.js
 *   node scripts/build_inverted_index.js path/to/jam_data.json
 *   node scripts/build_inverted_index.js --stats   # print stats, don't write
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const statsOnly  = args.includes("--stats");
const inputFile  = args.find(a => !a.startsWith("--")) ||
                   path.resolve(__dirname, "../data/jam_data.json");
const outputDir  = path.resolve(__dirname, "../data");

// ─── Normalize helpers ────────────────────────────────────────────────────────

/** Lowercase, trim, collapse whitespace */
const norm = s => (s || "").toLowerCase().trim().replace(/\s+/g, " ");

/** Split comma-separated itch fields, trim each, drop empties */
const splitField = s =>
  (s || "").split(",").map(t => t.trim()).filter(Boolean);

/** Map "Average session" strings to a numeric scope tier (1-5) */
const SCOPE_MAP = {
  "a few seconds":   1,
  "a few minutes":   2,
  "about a half-hour": 3,
  "about an hour":   4,
  "a few hours":     5,
  "days or more":    5,
};

function scopeTier(session) {
  return SCOPE_MAP[norm(session)] || 0; // 0 = unknown
}

/** Bucket team size into solo / small / medium / large */
function teamBucket(n) {
  if (n <= 1) return "solo";
  if (n <= 3) return "small_team";   // 2-3
  if (n <= 6) return "medium_team";  // 4-6
  return "large_team";               // 7+
}

/**
 * Extract perspective from tags.
 * Returns array like ["2d"], ["3d", "first_person"], or [].
 */
function extractPerspectives(tags) {
  const perspectives = [];
  const t = norm(tags);
  if (t.includes("2d"))           perspectives.push("2d");
  if (t.includes("3d"))           perspectives.push("3d");
  if (t.includes("first-person")) perspectives.push("first_person");
  if (t.includes("top-down"))     perspectives.push("top_down");
  if (t.includes("isometric"))    perspectives.push("isometric");
  if (t.includes("side-scroller") || t.includes("sidescroller"))
    perspectives.push("side_scroller");
  return perspectives;
}

/**
 * Detect engine from "Made with" field.
 * itch often has "Unity, Blender, Audacity" — we want the actual game engine.
 */
const KNOWN_ENGINES = [
  "unity", "godot", "gamemaker", "construct", "unreal engine",
  "gdevelop", "ren'py", "renpy", "pico-8", "pico8", "phaser",
  "löve", "love2d", "love", "rpg maker", "gb studio", "bitsy",
  "twine", "defold", "monogame", "pygame", "raylib", "bevy",
  "haxeflixel", "stencyl", "ct.js", "scratch", "inform",
];

function extractEngine(madeWith) {
  if (!madeWith) return null;
  const lower = norm(madeWith);
  for (const eng of KNOWN_ENGINES) {
    if (lower.includes(eng)) {
      // Normalize a few common variants
      if (eng === "renpy" || eng === "ren'py") return "Ren'Py";
      if (eng === "pico8" || eng === "pico-8") return "PICO-8";
      if (eng === "löve" || eng === "love2d" || eng === "love") return "LÖVE";
      if (eng === "gb studio") return "GB Studio";
      if (eng === "rpg maker") return "RPG Maker";
      if (eng === "unreal engine") return "Unreal Engine";
      if (eng === "gamemaker") return "GameMaker";
      // Title-case the rest
      return eng.charAt(0).toUpperCase() + eng.slice(1);
    }
  }
  // Fallback: return first item (often the engine)
  const first = splitField(madeWith)[0];
  return first || null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log(`Reading ${inputFile} ...`);
  const raw = fs.readFileSync(inputFile, "utf-8");
  const jams = JSON.parse(raw);

  console.log(`Found ${jams.length} jams.`);

  // ── Output structures ──

  /**
   * inverted_index.json shape:
   * {
   *   genres:       { "puzzle": [id, id, ...], "action": [...], ... },
   *   tags:         { "pixel art": [...], "horror": [...], ... },
   *   themes:       { "roles reversed": [...], "loop": [...], ... },
   *   engines:      { "unity": [...], "godot": [...], ... },
   *   perspectives: { "2d": [...], "3d": [...], ... },
   *   team_size:    { "solo": [...], "small_team": [...], ... },
   *   scope:        { "1": [...], "2": [...], ... },          // 1=seconds, 5=hours
   *   jam_slugs:    { "gmtk-2025": [...], ... },
   * }
   */
  const index = {
    genres:       {},
    tags:         {},
    themes:       {},
    engines:      {},
    perspectives: {},
    team_size:    {},
    scope:        {},
    jam_slugs:    {},
  };

  /** game_profiles.json: { [gameId]: { ...profile } } */
  const profiles = {};

  // ── Stats counters ──
  let totalGames = 0;
  let skipped = 0;

  // ── Helper to push ID into an index bucket ──
  function indexAdd(facet, key, gameId) {
    const k = norm(key);
    if (!k) return;
    if (!index[facet][k]) index[facet][k] = [];
    index[facet][k].push(gameId);
  }

  // ── Process each jam ──
  for (const jam of jams) {
    const jamTheme = (jam.theme || "").trim();
    const jamSlug  = jam.slug || "";
    const jamName  = jam.name || "";
    const jamUrl   = jam.url  || "";

    for (const game of jam.topGames || []) {
      const gameId = game.gameId;
      if (!gameId) { skipped++; continue; }

      totalGames++;
      const details   = game.details || {};
      const moreInfo  = details.moreInfo || {};
      const resultData = game.resultData || {};
      const entryData  = game.entryData || {};

      // ── Parse fields ──
      const title       = details.title || resultData.title || "";
      const description = details.description || "";
      const genres      = splitField(moreInfo.Genre);
      const tags        = splitField(moreInfo.Tags);
      const madeWith    = moreInfo["Made with"] || "";
      const engine      = extractEngine(madeWith);
      const platforms   = moreInfo.Platforms || "";
      const avgSession  = moreInfo["Average session"] || "";
      const status      = moreInfo.Status || "";
      const screenshots = details.screenshots || [];
      const coverUrl    = resultData.cover_url || "";
      const gameUrl     = game.gameUrl || "";
      const overallRank = game.overallRank || null;
      const topCats     = game.topCategories || [];

      // Contributors → team size
      const contributors = resultData.contributors || [];
      const authorField  = moreInfo.Authors || moreInfo.Author || "";
      const teamSize = contributors.length ||
                        (authorField ? splitField(authorField).length : 0);

      // Perspectives from tags
      const perspectives = extractPerspectives(moreInfo.Tags || "");

      // Scope tier
      const scope = scopeTier(avgSession);

      // Criteria scores (rating breakdown)
      const criteria = {};
      for (const c of resultData.criteria || []) {
        const cName = norm(c.name);
        criteria[cName] = { score: c.score, rank: c.rank };
      }

      // Rating count
      const ratingCount = resultData.rating_count || 0;

      // ── Build profile ──
      profiles[gameId] = {
        id:          gameId,
        title,
        description: description.slice(0, 500), // truncate for size
        genres,
        tags,
        engine,
        madeWith,
        perspectives,
        teamSize,
        teamBucket:  teamBucket(teamSize),
        scope,
        avgSession,
        status,
        platforms,
        coverUrl,
        gameUrl,
        screenshots: screenshots.slice(0, 3),
        overallRank,
        topCategories: topCats,
        ratingCount,
        criteria,
        jamSlug:  jamSlug,
        jamName:  jamName,
        jamTheme: jamTheme,
        jamUrl:   jamUrl,
      };

      // ── Populate inverted index ──

      // Genres
      for (const g of genres) {
        indexAdd("genres", g, gameId);
      }

      // Tags (skip very generic ones that don't help retrieval)
      const SKIP_TAGS = new Set([
        "singleplayer", "indie", "no ai", "unity", "godot",
        "game maker's toolkit jam", "my first game jam",
        "short", "prototype",
      ]);
      for (const t of tags) {
        if (!SKIP_TAGS.has(norm(t))) {
          indexAdd("tags", t, gameId);
        }
      }

      // Jam theme → games
      if (jamTheme && norm(jamTheme) !== "no theme") {
        indexAdd("themes", jamTheme, gameId);
      }

      // Engine
      if (engine) {
        indexAdd("engines", engine, gameId);
      }

      // Perspectives
      for (const p of perspectives) {
        indexAdd("perspectives", p, gameId);
      }

      // Team size bucket
      indexAdd("team_size", teamBucket(teamSize), gameId);

      // Scope
      if (scope > 0) {
        indexAdd("scope", String(scope), gameId);
      }

      // Jam slug (for deduplication / diversity pass)
      if (jamSlug) {
        indexAdd("jam_slugs", jamSlug, gameId);
      }
    }
  }

  // ── Stats ──
  console.log(`\nProcessed ${totalGames} games (${skipped} skipped).`);
  console.log(`\n─── Index stats ───`);
  for (const [facet, buckets] of Object.entries(index)) {
    const termCount = Object.keys(buckets).length;
    const totalRefs = Object.values(buckets).reduce((s, arr) => s + arr.length, 0);
    console.log(`  ${facet.padEnd(14)} ${termCount} terms, ${totalRefs} refs`);
  }

  console.log(`\n─── Profile stats ───`);
  const pCount = Object.keys(profiles).length;
  console.log(`  ${pCount} game profiles`);

  // Field coverage
  let withGenre = 0, withTags = 0, withEngine = 0, withPersp = 0, withScope = 0;
  for (const p of Object.values(profiles)) {
    if (p.genres.length)       withGenre++;
    if (p.tags.length)         withTags++;
    if (p.engine)              withEngine++;
    if (p.perspectives.length) withPersp++;
    if (p.scope > 0)           withScope++;
  }
  console.log(`  Genre:       ${withGenre}/${pCount} (${Math.round(100*withGenre/pCount)}%)`);
  console.log(`  Tags:        ${withTags}/${pCount} (${Math.round(100*withTags/pCount)}%)`);
  console.log(`  Engine:      ${withEngine}/${pCount} (${Math.round(100*withEngine/pCount)}%)`);
  console.log(`  Perspective: ${withPersp}/${pCount} (${Math.round(100*withPersp/pCount)}%)`);
  console.log(`  Scope:       ${withScope}/${pCount} (${Math.round(100*withScope/pCount)}%)`);

  // ── Write output ──
  if (statsOnly) {
    console.log("\n--stats mode: skipping file writes.");
    return;
  }

  // Ensure output dir
  fs.mkdirSync(outputDir, { recursive: true });

  const indexPath   = path.join(outputDir, "inverted_index.json");
  const profilePath = path.join(outputDir, "game_profiles.json");

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
  console.log(`\n✅ Inverted index written to ${indexPath}`);
  console.log(`   ${(fs.statSync(indexPath).size / 1024).toFixed(0)} KB`);

  fs.writeFileSync(profilePath, JSON.stringify(profiles, null, 2), "utf-8");
  console.log(`✅ Game profiles written to ${profilePath}`);
  console.log(`   ${(fs.statSync(profilePath).size / 1024).toFixed(0)} KB`);

  // ── Write a compact theme catalog for the runtime LLM prompt ──
  // This is what gets sent to the LLM so it can map user themes to index terms.
  const themeCatalog = {
    jam_themes: [...new Set(
      jams.map(j => j.theme).filter(t => t && norm(t) !== "no theme")
    )].sort(),
    genres: Object.keys(index.genres).sort(),
    top_tags: Object.entries(index.tags)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 100)
      .map(([tag]) => tag)
      .sort(),
    engines: Object.keys(index.engines).sort(),
    perspectives: Object.keys(index.perspectives).sort(),
    team_buckets: Object.keys(index.team_size).sort(),
    scope_tiers: { "1": "seconds", "2": "minutes", "3": "half-hour", "4": "hour", "5": "hours" },
  };

  const catalogPath = path.join(outputDir, "theme_catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify(themeCatalog, null, 2), "utf-8");
  console.log(`✅ Theme catalog written to ${catalogPath}`);
  console.log(`   ${(fs.statSync(catalogPath).size / 1024).toFixed(0)} KB`);
  console.log(`   ${themeCatalog.jam_themes.length} themes, ${themeCatalog.genres.length} genres, ${themeCatalog.top_tags.length} tags`);
}

main();
