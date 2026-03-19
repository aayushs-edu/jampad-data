/**
 * inspiration_engine.js
 *
 * JamPad's Inspiration Engine — the core query pipeline.
 *
 * Takes a user's jam theme + constraints and returns 3-5 inspiration paths,
 * each grounded in real jam games and (optionally) commercial IGDB references.
 *
 * Pipeline:
 *   1. Theme interpreter  (LLM)  — maps freeform theme → index terms
 *   2. Retrieve + filter  (code) — inverted index lookup + hard filters
 *   3. Score + diversify  (code) — weighted composite + genre/jam spread
 *   4. IGDB reference     (API)  — commercial games per genre cluster
 *   5. Path narrator      (LLM)  — synthesizes inspiration paths
 *
 * Usage:
 *   const engine = require("./inspiration_engine");
 *   await engine.init();
 *   const result = await engine.query({
 *     theme: "gravity",
 *     engine: "Unity",
 *     perspective: "2d",
 *     team: "solo",
 *     scope: 2,
 *     genres: ["puzzle", "platformer"],
 *   });
 *
 * Environment:
 *   GEMINI_API_KEY  — required for LLM steps (falls back to substring matcher)
 *   DATA_DIR        — optional, default: ../data
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const llm = require("./llm_client");

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR ||
                 path.resolve(__dirname, "../data");

const LOG = process.env.ENGINE_LOG === "1" || process.env.LLM_LOG === "1";

// ─── State (loaded on init) ───────────────────────────────────────────────────

let idx      = null;  // inverted_index.json
let profiles = null;  // game_profiles.json
let catalog  = null;  // theme_catalog.json
let igdb     = null;  // igdb_client (optional)

const norm = s => (s || "").toLowerCase().trim();

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Load data files. Call once at startup.
 * @param {Object} [opts]
 * @param {boolean} [opts.skipIGDB=false] — skip IGDB client init
 */
async function init(opts = {}) {
  const t0 = Date.now();

  idx = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "inverted_index.json"), "utf-8")
  );
  profiles = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "game_profiles.json"), "utf-8")
  );
  catalog = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "theme_catalog.json"), "utf-8")
  );

  // Try loading IGDB client (optional — engine works without it)
  if (!opts.skipIGDB) {
    try {
      igdb = require("./igdb_client");
      await igdb.init();
      if (LOG) console.error(`[engine] IGDB client initialized`);
    } catch (err) {
      igdb = null;
      if (LOG) console.error(`[engine] IGDB not available: ${err.message}`);
    }
  }

  if (LOG) {
    const gameCount = Object.keys(profiles).length;
    const elapsed = Date.now() - t0;
    console.error(`[engine] Loaded ${gameCount} profiles, ${catalog.jam_themes.length} themes in ${elapsed}ms`);
    console.error(`[engine] LLM status:`, llm.status().ready ? "ready" : "not configured");
  }
}

// ─── Step 1: Theme Interpreter ────────────────────────────────────────────────

const INTERPRETER_SYSTEM = `You are JamPad's theme interpreter. Given a game jam theme and optional constraints, return the most relevant search terms from JamPad's database.

Your job is semantic bridging — mapping the user's words to terms that exist in the database. Be creative with thematic connections but ONLY return exact strings from the provided vocabulary lists. Do not invent or modify terms.`;

function buildInterpreterPrompt(theme, limitation) {
  let prompt = `Theme: "${theme}"`;
  if (limitation) prompt += `\nLimitation: "${limitation}"`;

  prompt += `

VOCABULARY — return ONLY exact strings from these lists:

Jam themes: ${JSON.stringify(catalog.jam_themes)}

Genres: ${JSON.stringify(catalog.genres)}

Tags (pick the most relevant): ${JSON.stringify(catalog.top_tags)}

Return the terms most semantically related to the theme.`;

  return prompt;
}

/**
 * Call the LLM to interpret the user's theme into index terms.
 * Falls back to substring matching if the LLM is unavailable.
 */
async function interpretTheme(theme, limitation) {
  // Try LLM first
  if (llm.status().ready) {
    try {
      const result = await llm.complete({
        system: INTERPRETER_SYSTEM,
        user:   buildInterpreterPrompt(theme, limitation),
        schema: llm.THEME_INTERPRETER_SCHEMA,
        quality: "fast",
        temperature: 0.3,
      });

      // Validate: strip any terms that aren't in our index
      const validThemes = new Set(Object.keys(idx.themes));
      const validTags   = new Set(Object.keys(idx.tags));
      const validGenres = new Set(Object.keys(idx.genres));

      return {
        themeMatches: (result.theme_matches || []).filter(t => validThemes.has(norm(t))).map(norm),
        tagMatches:   (result.tag_matches || []).filter(t => validTags.has(norm(t))).map(norm),
        genreMatches: (result.genre_hints || []).filter(g => validGenres.has(norm(g))).map(norm),
        concepts:     result.concepts || [],
        llmUsed:      true,
      };
    } catch (err) {
      if (LOG) console.error(`[engine] LLM interpreter failed, falling back: ${err.message}`);
    }
  }

  // Fallback: substring matching (same logic as query_test.js)
  return fallbackMatch(theme);
}

function fallbackMatch(theme) {
  const q = norm(theme);
  const words = q.split(/\s+/).filter(w => w.length > 2);

  const themeMatches = [];
  const tagMatches = [];
  const genreMatches = [];

  for (const t of catalog.jam_themes) {
    const tn = norm(t);
    if (tn.includes(q) || q.includes(tn)) { themeMatches.push(tn); continue; }
    const tWords = tn.split(/\s+/);
    const overlap = words.filter(w => tWords.some(tw => tw.includes(w) || w.includes(tw)));
    if (overlap.length > 0 && overlap.length >= Math.min(words.length, tWords.length) * 0.5) {
      themeMatches.push(tn);
    }
  }

  for (const tag of catalog.top_tags) {
    const tn = norm(tag);
    if (tn.includes(q) || q.includes(tn)) { tagMatches.push(tn); continue; }
    for (const w of words) {
      if (tn.includes(w) || w.includes(tn)) { tagMatches.push(tn); break; }
    }
  }

  for (const genre of catalog.genres) {
    const gn = norm(genre);
    if (gn.includes(q) || q.includes(gn)) { genreMatches.push(gn); continue; }
    for (const w of words) {
      if (gn === w || gn.includes(w)) { genreMatches.push(gn); break; }
    }
  }

  return { themeMatches, tagMatches, genreMatches, concepts: [], llmUsed: false };
}

// ─── Step 2: Retrieve ─────────────────────────────────────────────────────────

function retrieve(matches) {
  const candidates = new Set();

  for (const t of matches.themeMatches) {
    for (const id of idx.themes[t] || []) candidates.add(id);
  }
  for (const t of matches.tagMatches) {
    for (const id of idx.tags[t] || []) candidates.add(id);
  }
  for (const g of matches.genreMatches) {
    for (const id of idx.genres[g] || []) candidates.add(id);
  }

  return candidates;
}

// ─── Step 3: Filter + Score ───────────────────────────────────────────────────

function filterAndScore(candidateIds, constraints, matches) {
  let games = [...candidateIds]
    .map(id => profiles[id])
    .filter(Boolean);

  const beforeFilter = games.length;

  // Hard filters
  if (constraints.engine) {
    const eng = norm(constraints.engine);
    games = games.filter(p =>
      !p.engine || norm(p.engine).includes(eng) || eng.includes(norm(p.engine))
    );
  }
  if (constraints.perspective) {
    const persp = norm(constraints.perspective);
    games = games.filter(p =>
      p.perspectives.length === 0 || p.perspectives.includes(persp)
    );
  }

  // Graceful degradation: if filters killed everything, relax
  if (games.length === 0 && beforeFilter > 0) {
    if (LOG) console.error(`[engine] Filters too strict (${beforeFilter} → 0), relaxing`);
    // Re-retrieve without engine filter
    games = [...candidateIds].map(id => profiles[id]).filter(Boolean);
    if (constraints.perspective) {
      const persp = norm(constraints.perspective);
      games = games.filter(p =>
        p.perspectives.length === 0 || p.perspectives.includes(persp)
      );
    }
  }

  // Score
  const boostGenres = (constraints.genres || []).map(norm);

  for (const p of games) {
    let s = 0;
    const breakdown = {};

    // Theme match (0.35) — game came from a matched jam theme
    const jamNorm = norm(p.jamTheme);
    if (matches.themeMatches.includes(jamNorm)) {
      s += 0.35; breakdown.theme = 0.35;
    }

    // Tag overlap (0.15) — game's tags match LLM-suggested tags
    const gameTags = (p.tags || []).map(norm);
    const tagHits = gameTags.filter(t => matches.tagMatches.includes(t)).length;
    const tagScore = Math.min(tagHits * 0.05, 0.15);
    if (tagScore > 0) { s += tagScore; breakdown.tags = tagScore; }

    // Genre match (0.20)
    const gameGenres = (p.genres || []).map(norm);
    const genreHit = gameGenres.some(g =>
      matches.genreMatches.includes(g) || boostGenres.includes(g)
    );
    if (genreHit) { s += 0.20; breakdown.genre = 0.20; }

    // Team size fit (0.10)
    if (constraints.team && p.teamBucket === constraints.team) {
      s += 0.10; breakdown.team = 0.10;
    }

    // Scope fit (0.10)
    if (constraints.scope && p.scope > 0) {
      const diff = Math.abs(p.scope - constraints.scope);
      const scopeScore = diff === 0 ? 0.10 : diff === 1 ? 0.05 : 0;
      if (scopeScore > 0) { s += scopeScore; breakdown.scope = scopeScore; }
    }

    // Quality signal (0.10)
    if (p.overallRank && p.overallRank <= 10) {
      s += 0.10; breakdown.quality = 0.10;
    } else if (p.overallRank && p.overallRank <= 30) {
      s += 0.05; breakdown.quality = 0.05;
    }

    p._score = s;
    p._breakdown = breakdown;
  }

  games.sort((a, b) => b._score - a._score);
  return games;
}

// ─── Step 4: Diversity Pass ───────────────────────────────────────────────────

function diversify(games, limit = 10) {
  const result = [];
  const genreCounts = {};
  const jamCounts   = {};
  const MAX_PER_GENRE = 3;
  const MAX_PER_JAM   = 3;

  for (const g of games) {
    if (result.length >= limit) break;

    const primaryGenre = norm(g.genres[0] || "unknown");
    const jam = g.jamSlug;

    if ((genreCounts[primaryGenre] || 0) >= MAX_PER_GENRE) continue;
    if ((jamCounts[jam] || 0) >= MAX_PER_JAM) continue;

    result.push(g);
    genreCounts[primaryGenre] = (genreCounts[primaryGenre] || 0) + 1;
    jamCounts[jam] = (jamCounts[jam] || 0) + 1;
  }

  return result;
}

// ─── Step 5: IGDB Reference Games ─────────────────────────────────────────────

/**
 * For each genre cluster in the results, find 1-2 polished commercial games.
 * Returns an array of IGDB game objects, or [] if IGDB is not available.
 */
async function fetchIGDBReferences(games) {
  if (!igdb) return [];

  // Group result games by primary genre
  const genreClusters = {};
  for (const g of games) {
    const genre = g.genres[0] || "Action";
    if (!genreClusters[genre]) genreClusters[genre] = [];
    genreClusters[genre].push(g);
  }

  const igdbGames = [];
  const seenIds = new Set();

  // Limit to top 3 genre clusters to stay within rate limits
  const topClusters = Object.entries(genreClusters)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3);

  for (const [genre, clusterGames] of topClusters) {
    try {
      // Collect tags from cluster games for richer queries
      const clusterTags = [...new Set(
        clusterGames.flatMap(g => g.tags || []).filter(t =>
          !["2D", "3D", "Singleplayer", "Short", "Pixel Art"].includes(t)
        )
      )].slice(0, 3);

      const results = await igdb.findGames({
        genres: [genre],
        themes: clusterTags,
        minRating: 70,
        limit: 2,
      });

      for (const r of results) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          igdbGames.push({
            source: "igdb",
            id:     r.id,
            title:  r.name,
            genres: (r.genres || []).map(g => g.name),
            themes: (r.themes || []).map(t => t.name),
            summary: (r.summary || "").slice(0, 200),
            rating: r.rating ? Math.round(r.rating) : null,
            coverUrl:    r._images?.cover || null,
            screenshots: r._images?.screenshots || [],
            url: r.url || null,
            forGenreCluster: genre,
          });
        }
      }
    } catch (err) {
      if (LOG) console.error(`[engine] IGDB query failed for ${genre}: ${err.message}`);
    }
  }

  return igdbGames;
}

// ─── Step 6: Path Narrator ────────────────────────────────────────────────────

const NARRATOR_SYSTEM = `You are JamPad's inspiration narrator. Given a game jam theme, user constraints, and a set of real games (both indie jam games and commercial reference games), create 3-5 distinct "inspiration paths" — each representing a different creative direction the user could take.

Rules:
- Every path MUST reference at least one real game by its ID from the provided list
- Do NOT invent games or IDs — only use IDs from the "Candidate games" list
- Keep descriptions actionable for someone with limited time
- Each path should feel meaningfully different from the others
- scope_hint should say what to build in the first 4 hours, then what to add if time permits`;

function buildNarratorPrompt(theme, constraints, itchGames, igdbGames, concepts) {
  const constraintLines = [];
  if (constraints.engine)      constraintLines.push(`Engine: ${constraints.engine}`);
  if (constraints.perspective) constraintLines.push(`Perspective: ${constraints.perspective}`);
  if (constraints.team)        constraintLines.push(`Team: ${constraints.team}`);
  if (constraints.scope)       constraintLines.push(`Time: scope tier ${constraints.scope} (1=seconds, 2=mins, 3=half-hour, 4=hour, 5=hours)`);
  if (concepts.length)         constraintLines.push(`Abstract concepts: ${concepts.join(", ")}`);

  const gameEntries = itchGames.map(g => {
    const desc = (g.description || "").replace(/\n/g, " ").slice(0, 150);
    return `  ID:${g.id} "${g.title}" [${g.genres.join("/")}] tags:[${(g.tags||[]).slice(0,5).join(",")}] jam:"${g.jamTheme}" rank:#${g.overallRank} desc:"${desc}"`;
  });

  let prompt = `Theme: "${theme}"`;
  if (constraints.limitation) prompt += `\nLimitation: "${constraints.limitation}"`;
  if (constraintLines.length) prompt += `\n${constraintLines.join("\n")}`;

  prompt += `\n\nCandidate games:\n${gameEntries.join("\n")}`;

  if (igdbGames.length > 0) {
    const igdbEntries = igdbGames.map(g =>
      `  "${g.title}" [${g.genres.join("/")}] — ${(g.summary || "").slice(0, 100)}`
    );
    prompt += `\n\nCommercial reference games (for context, not for game_ids):\n${igdbEntries.join("\n")}`;
  }

  prompt += `\n\nCreate 3-5 inspiration paths. Each path's game_ids must ONLY contain IDs from the candidate games list above.`;

  return prompt;
}

/**
 * Call the LLM to generate inspiration paths from scored games.
 * Falls back to a simple auto-grouping if the LLM is unavailable.
 */
async function narratePaths(theme, constraints, itchGames, igdbGames, concepts) {
  // Try LLM narrator
  if (llm.status().ready && itchGames.length > 0) {
    try {
      const result = await llm.complete({
        system: NARRATOR_SYSTEM,
        user:   buildNarratorPrompt(theme, constraints, itchGames, igdbGames, concepts),
        schema: llm.NARRATOR_SCHEMA,
        quality: "smart",
        temperature: 0.5,
      });

      // Validate: ensure game_ids reference actual candidates
      const validIds = new Set(itchGames.map(g => g.id));
      for (const p of result.paths || []) {
        p.game_ids = (p.game_ids || []).filter(id => validIds.has(id));
      }
      // Drop paths with no valid game references
      result.paths = (result.paths || []).filter(p => p.game_ids.length > 0);

      return { paths: result.paths, llmUsed: true };
    } catch (err) {
      if (LOG) console.error(`[engine] LLM narrator failed, falling back: ${err.message}`);
    }
  }

  // Fallback: auto-group by primary genre
  return fallbackNarrate(itchGames);
}

function fallbackNarrate(games) {
  const groups = {};
  for (const g of games) {
    const genre = g.genres[0] || "Other";
    if (!groups[genre]) groups[genre] = [];
    groups[genre].push(g);
  }

  const paths = Object.entries(groups).slice(0, 5).map(([genre, groupGames]) => ({
    name:        `${genre} direction`,
    pitch:       `Explore a ${genre.toLowerCase()} approach inspired by ${groupGames.length} jam games.`,
    why_it_fits: `These games were made for jams with similar themes.`,
    game_ids:    groupGames.map(g => g.id),
    scope_hint:  "Start with the core mechanic, add polish later.",
    mood:        "varied",
  }));

  return { paths, llmUsed: false };
}

// ─── Main Query ───────────────────────────────────────────────────────────────

/**
 * Run the full Inspiration Engine pipeline.
 *
 * @param {Object} opts
 * @param {string} opts.theme           — jam theme (required)
 * @param {string} [opts.limitation]    — optional jam limitation/constraint
 * @param {string} [opts.engine]        — hard filter: game engine
 * @param {string} [opts.perspective]   — hard filter: "2d", "3d", etc.
 * @param {string} [opts.team]          — soft filter: "solo", "small_team", etc.
 * @param {number} [opts.scope]         — soft filter: 1-5
 * @param {string[]} [opts.genres]      — boost these genres
 * @param {number} [opts.limit]         — max games to pass to narrator (default 10)
 * @param {boolean} [opts.skipNarrator] — skip step 5 (useful for testing)
 * @param {boolean} [opts.skipIGDB]     — skip step 4
 *
 * @returns {Object} { paths, games, igdbGames, meta }
 */
async function query(opts) {
  if (!idx) throw new Error("Engine not initialized. Call init() first.");
  if (!opts.theme) throw new Error("opts.theme is required");

  const t0 = Date.now();
  const limit = opts.limit || 10;

  // ── Step 1: Theme interpreter ──
  const tInterp0 = Date.now();
  const matches = await interpretTheme(opts.theme, opts.limitation);

  // If user specified genres, merge them in
  if (opts.genres) {
    for (const g of opts.genres.map(norm)) {
      if (!matches.genreMatches.includes(g)) matches.genreMatches.push(g);
    }
  }
  const tInterp = Date.now() - tInterp0;

  if (LOG) {
    console.error(`[engine] Interpreted (${tInterp}ms, llm=${matches.llmUsed}):`);
    console.error(`  themes: ${matches.themeMatches.join(", ") || "(none)"}`);
    console.error(`  tags:   ${matches.tagMatches.join(", ") || "(none)"}`);
    console.error(`  genres: ${matches.genreMatches.join(", ") || "(none)"}`);
    console.error(`  concepts: ${matches.concepts.join(", ") || "(none)"}`);
  }

  // ── Step 2: Retrieve ──
  const candidateIds = retrieve(matches);
  const candidateCount = candidateIds.size;

  // ── Step 3: Filter + Score ──
  const scored = filterAndScore(candidateIds, opts, matches);
  const filteredCount = scored.length;

  // ── Step 3b: Diversity pass ──
  const diverse = diversify(scored, limit);

  if (LOG) {
    console.error(`[engine] Candidates: ${candidateCount} → filtered: ${filteredCount} → diverse: ${diverse.length}`);
  }

  // ── Step 4: IGDB references ──
  let igdbGames = [];
  if (!opts.skipIGDB && igdb) {
    const tIgdb0 = Date.now();
    igdbGames = await fetchIGDBReferences(diverse);
    if (LOG) console.error(`[engine] IGDB: ${igdbGames.length} games (${Date.now() - tIgdb0}ms)`);
  }

  // ── Step 5: Narrator ──
  let narratorResult = { paths: [], llmUsed: false };
  if (!opts.skipNarrator && diverse.length > 0) {
    const tNarr0 = Date.now();
    narratorResult = await narratePaths(
      opts.theme, opts, diverse, igdbGames, matches.concepts
    );
    if (LOG) console.error(`[engine] Narrator: ${narratorResult.paths.length} paths (${Date.now() - tNarr0}ms)`);
  }

  // ── Build response ──

  // Attach game data to each path
  const profileMap = {};
  for (const g of diverse) {
    profileMap[g.id] = {
      source:        "itch",
      id:            g.id,
      title:         g.title,
      genres:        g.genres,
      tags:          g.tags,
      engine:        g.engine,
      perspectives:  g.perspectives,
      teamSize:      g.teamSize,
      description:   g.description,
      coverUrl:      g.coverUrl,
      gameUrl:       g.gameUrl,
      screenshots:   g.screenshots,
      jamTheme:      g.jamTheme,
      jamName:       g.jamName,
      overallRank:   g.overallRank,
      topCategories: g.topCategories,
      ratingCount:   g.ratingCount,
      _score:        g._score,
      _breakdown:    g._breakdown,
    };
  }

  const paths = narratorResult.paths.map(p => ({
    ...p,
    games: [
      ...(p.game_ids || []).map(id => profileMap[id]).filter(Boolean),
      // Attach relevant IGDB games if they match this path's genre cluster
      ...igdbGames.filter(ig => {
        const pathGenres = (p.game_ids || [])
          .map(id => profileMap[id])
          .filter(Boolean)
          .flatMap(g => g.genres.map(norm));
        return pathGenres.some(pg =>
          ig.genres.some(ig2 => norm(ig2) === pg)
        );
      }),
    ],
  }));

  const totalMs = Date.now() - t0;

  return {
    paths,
    meta: {
      theme:          opts.theme,
      limitation:     opts.limitation || null,
      candidateCount,
      filteredCount,
      resultCount:    diverse.length,
      pathCount:      paths.length,
      interpreterLLM: matches.llmUsed,
      narratorLLM:    narratorResult.llmUsed,
      igdbCount:      igdbGames.length,
      queryTimeMs:    totalMs,
      interpretation: {
        themes:   matches.themeMatches,
        tags:     matches.tagMatches,
        genres:   matches.genreMatches,
        concepts: matches.concepts,
      },
    },
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { init, query };
