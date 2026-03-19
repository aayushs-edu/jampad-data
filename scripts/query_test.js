/**
 * query_test.js
 *
 * Interactive CLI to test the inverted index retrieval + scoring pipeline.
 * Simulates what the runtime engine would do after the LLM theme interpreter.
 *
 * Usage:
 *   node scripts/query_test.js --theme "Connected"
 *   node scripts/query_test.js --theme "Horror" --engine Unity --perspective 2d
 *   node scripts/query_test.js --theme "time loop" --team solo --scope 2
 *   node scripts/query_test.js --theme "gravity" --genres "puzzle,platformer"
 *   node scripts/query_test.js --list-themes
 *   node scripts/query_test.js --list-tags
 *   node scripts/query_test.js --interactive
 *
 * Flags:
 *   --theme <text>         Theme to search (fuzzy-matched against jam themes + tags)
 *   --engine <name>        Hard filter: engine name
 *   --perspective <2d|3d>  Hard filter: perspective
 *   --team <solo|small_team|medium_team|large_team>  Soft filter
 *   --scope <1-5>          Soft filter: 1=seconds, 2=mins, 3=half-hour, 4=hour, 5=hours
 *   --genres <csv>         Boost these genres
 *   --limit <n>            Results to show (default: 15)
 *   --verbose              Show scoring breakdown
 *   --list-themes          Print all jam themes
 *   --list-tags            Print top tags
 *   --list-genres          Print all genres
 *   --interactive          Enter queries in a loop
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Load data ────────────────────────────────────────────────────────────────

const dataDir     = process.env.DATA_DIR || path.resolve(__dirname, "../data");
const idx         = JSON.parse(fs.readFileSync(path.join(dataDir, "inverted_index.json"), "utf-8"));
const profiles    = JSON.parse(fs.readFileSync(path.join(dataDir, "game_profiles.json"), "utf-8"));
const catalog     = JSON.parse(fs.readFileSync(path.join(dataDir, "theme_catalog.json"), "utf-8"));

const norm = s => (s || "").toLowerCase().trim();

// ─── Theme matching (simulates what the LLM would do) ─────────────────────────

/**
 * Fuzzy-match a user theme string against jam themes and tags.
 * Returns { themeMatches: string[], tagMatches: string[], genreMatches: string[] }
 *
 * This is a DETERMINISTIC approximation of what the LLM would return.
 * The real pipeline uses an LLM for semantic bridging; this uses substring matching.
 */
function matchTheme(userTheme) {
  const q = norm(userTheme);
  const words = q.split(/\s+/).filter(w => w.length > 2);

  const themeMatches = [];
  const tagMatches   = [];
  const genreMatches = [];

  // Match jam themes: substring or word overlap
  for (const theme of catalog.jam_themes) {
    const t = norm(theme);
    if (t.includes(q) || q.includes(t)) {
      themeMatches.push(t);
      continue;
    }
    // Word overlap
    const tWords = t.split(/\s+/);
    const overlap = words.filter(w => tWords.some(tw => tw.includes(w) || w.includes(tw)));
    if (overlap.length > 0 && overlap.length >= Math.min(words.length, tWords.length) * 0.5) {
      themeMatches.push(t);
    }
  }

  // Match tags
  for (const tag of catalog.top_tags) {
    const t = norm(tag);
    if (t.includes(q) || q.includes(t)) {
      tagMatches.push(t);
      continue;
    }
    for (const w of words) {
      if (t.includes(w) || w.includes(t)) {
        tagMatches.push(t);
        break;
      }
    }
  }

  // Match genres
  for (const genre of catalog.genres) {
    const g = norm(genre);
    if (g.includes(q) || q.includes(g)) {
      genreMatches.push(g);
      continue;
    }
    for (const w of words) {
      if (g === w || g.includes(w)) {
        genreMatches.push(g);
        break;
      }
    }
  }

  return { themeMatches, tagMatches, genreMatches };
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

function retrieve(matches) {
  const candidates = new Set();

  for (const t of matches.themeMatches) {
    for (const id of idx.jam_themes[t] || []) candidates.add(id);
  }
  for (const t of matches.tagMatches) {
    for (const id of idx.tags[t] || []) candidates.add(id);
  }
  for (const g of matches.genreMatches) {
    for (const id of idx.genres[g] || []) candidates.add(id);
  }

  return candidates;
}

// ─── Filter + Score ───────────────────────────────────────────────────────────

function filterAndScore(candidateIds, opts, matches) {
  let games = [...candidateIds]
    .map(id => profiles[id])
    .filter(Boolean);

  // Hard filters
  if (opts.engine) {
    const eng = norm(opts.engine);
    games = games.filter(p =>
      !p.engine || norm(p.engine).includes(eng) || eng.includes(norm(p.engine))
    );
  }
  if (opts.perspective) {
    const persp = norm(opts.perspective);
    games = games.filter(p =>
      p.perspectives.length === 0 || p.perspectives.includes(persp)
    );
  }

  // Score
  const boostGenres = (opts.genres || []).map(norm);

  for (const p of games) {
    let s = 0;
    const breakdown = {};

    // Theme match (0.35)
    const jamThemeNorm = norm(p.jamTheme);
    const isThemeMatch = matches.themeMatches.includes(jamThemeNorm);
    if (isThemeMatch) { s += 0.35; breakdown.theme = 0.35; }

    // Tag match (0.15) — game's tags overlap with matched tags
    const gameTags = (p.tags || []).map(norm);
    const tagOverlap = gameTags.filter(t => matches.tagMatches.includes(t)).length;
    const tagScore = Math.min(tagOverlap * 0.05, 0.15);
    if (tagScore > 0) { s += tagScore; breakdown.tags = tagScore; }

    // Genre match (0.20)
    const gameGenres = (p.genres || []).map(norm);
    const genreHit = gameGenres.some(g =>
      matches.genreMatches.includes(g) || boostGenres.includes(g)
    );
    if (genreHit) { s += 0.20; breakdown.genre = 0.20; }

    // Team size fit (0.10)
    if (opts.team && p.teamBucket === opts.team) {
      s += 0.10; breakdown.team = 0.10;
    }

    // Scope fit (0.10)
    if (opts.scope && p.scope > 0) {
      const diff = Math.abs(p.scope - opts.scope);
      const scopeScore = diff === 0 ? 0.10 : diff === 1 ? 0.05 : 0;
      if (scopeScore > 0) { s += scopeScore; breakdown.scope = scopeScore; }
    }

    // Quality signal (0.10) — top-ranked games get a boost
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

// ─── Diversity pass ───────────────────────────────────────────────────────────

function diversify(games, limit) {
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

// ─── Display ──────────────────────────────────────────────────────────────────

function display(games, opts, matches, candidateCount, filteredCount) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`Theme matches:  ${matches.themeMatches.join(", ") || "(none)"}`);
  console.log(`Tag matches:    ${matches.tagMatches.join(", ") || "(none)"}`);
  console.log(`Genre matches:  ${matches.genreMatches.join(", ") || "(none)"}`);
  console.log(`Candidates: ${candidateCount} → after filters: ${filteredCount} → showing: ${games.length}`);
  console.log(`${"─".repeat(70)}`);

  if (games.length === 0) {
    console.log("  No results. Try broadening your query.");
    return;
  }

  for (let i = 0; i < games.length; i++) {
    const p = games[i];
    const rank = p.overallRank ? `#${p.overallRank}` : "unranked";
    const engine = p.engine || "?";
    const team = `${p.teamSize}p`;
    const persp = p.perspectives.join("/") || "?";

    console.log(`\n  ${i + 1}. [${p._score.toFixed(2)}] ${p.title}`);
    console.log(`     ${p.genres.join(", ")} | ${persp} | ${engine} | ${team} | ${rank} in "${p.jamTheme}"`);
    console.log(`     ${p.gameUrl}`);

    if (opts.verbose && p._breakdown) {
      const parts = Object.entries(p._breakdown)
        .map(([k, v]) => `${k}:${v.toFixed(2)}`)
        .join(" + ");
      console.log(`     scoring: ${parts}`);
    }

    // Show first 120 chars of description
    if (p.description) {
      const desc = p.description.replace(/\n/g, " ").slice(0, 120);
      console.log(`     "${desc}${p.description.length > 120 ? "..." : ""}"`);
    }
  }

  // Summary
  const genreSpread = {};
  const jamSpread   = {};
  for (const g of games) {
    for (const genre of g.genres) genreSpread[genre] = (genreSpread[genre] || 0) + 1;
    jamSpread[g.jamName] = (jamSpread[g.jamName] || 0) + 1;
  }
  console.log(`\n  Genre spread: ${JSON.stringify(genreSpread)}`);
  console.log(`  Jam spread:   ${Object.entries(jamSpread).map(([k,v]) => `${k}(${v})`).join(", ")}`);
}

// ─── Run query ────────────────────────────────────────────────────────────────

function runQuery(opts) {
  const matches = matchTheme(opts.theme);

  // If user also specified genres, add them
  if (opts.genres) {
    for (const g of opts.genres.map(norm)) {
      if (!matches.genreMatches.includes(g)) matches.genreMatches.push(g);
    }
  }

  const candidateIds = retrieve(matches);
  const scored = filterAndScore(candidateIds, opts, matches);
  const results = diversify(scored, opts.limit || 15);

  display(results, opts, matches, candidateIds.size, scored.length);
}

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { limit: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--theme" && argv[i + 1])        { opts.theme = argv[++i]; }
    else if (a === "--engine" && argv[i + 1])   { opts.engine = argv[++i]; }
    else if (a === "--perspective" && argv[i+1]) { opts.perspective = argv[++i]; }
    else if (a === "--team" && argv[i + 1])     { opts.team = argv[++i]; }
    else if (a === "--scope" && argv[i + 1])    { opts.scope = parseInt(argv[++i]); }
    else if (a === "--genres" && argv[i + 1])   { opts.genres = argv[++i].split(",").map(s => s.trim()); }
    else if (a === "--limit" && argv[i + 1])    { opts.limit = parseInt(argv[++i]); }
    else if (a === "--verbose")                 { opts.verbose = true; }
    else if (a === "--list-themes")             { opts.listThemes = true; }
    else if (a === "--list-tags")               { opts.listTags = true; }
    else if (a === "--list-genres")             { opts.listGenres = true; }
    else if (a === "--interactive")             { opts.interactive = true; }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.listThemes) {
    console.log("Jam themes in index:");
    for (const t of catalog.jam_themes) {
      const count = (idx.jam_themes[norm(t)] || []).length;
      console.log(`  ${t} (${count} games)`);
    }
    return;
  }
  if (opts.listTags) {
    console.log("Top 100 tags in index:");
    const sorted = Object.entries(idx.tags).sort((a,b) => b[1].length - a[1].length).slice(0, 100);
    for (const [tag, ids] of sorted) {
      console.log(`  ${tag} (${ids.length})`);
    }
    return;
  }
  if (opts.listGenres) {
    console.log("Genres in index:");
    for (const g of catalog.genres) {
      console.log(`  ${g} (${(idx.genres[g] || []).length})`);
    }
    return;
  }

  if (opts.interactive) {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("Interactive mode. Type a theme query (or 'q' to quit).");
    console.log("Format: <theme> [--engine X] [--perspective 2d|3d] [--team solo] [--verbose]");
    const ask = () => {
      rl.question("\n> ", (line) => {
        line = line.trim();
        if (!line || line === "q" || line === "quit") { rl.close(); return; }
        const parts = line.split(/\s+/);
        // Separate theme words from flags
        const flagIdx = parts.findIndex(p => p.startsWith("--"));
        const themeWords = flagIdx === -1 ? parts : parts.slice(0, flagIdx);
        const flags = flagIdx === -1 ? [] : parts.slice(flagIdx);
        const queryOpts = parseArgs(flags);
        queryOpts.theme = themeWords.join(" ");
        queryOpts.limit = queryOpts.limit || 10;
        runQuery(queryOpts);
        ask();
      });
    };
    ask();
    return;
  }

  if (!opts.theme) {
    console.log("Usage: node query_test.js --theme \"your theme\" [options]");
    console.log("       node query_test.js --interactive");
    console.log("       node query_test.js --list-themes");
    console.log("Try: node query_test.js --theme \"time loop\" --verbose");
    return;
  }

  runQuery(opts);
}

main();
