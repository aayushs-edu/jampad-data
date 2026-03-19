#!/usr/bin/env node
/**
 * test_engine.js
 *
 * End-to-end CLI tester for the Inspiration Engine pipeline.
 * Runs real queries through the full pipeline (LLM + index + scoring + narrator).
 *
 * Usage:
 *   node scripts/test_engine.js --theme "gravity"
 *   node scripts/test_engine.js --theme "horror" --engine Godot --perspective 2d --team solo
 *   node scripts/test_engine.js --theme "time loop" --skip-narrator       # skip narrator (test retrieval only)
 *   node scripts/test_engine.js --theme "card game" --genres "card game"  # boost genres
 *   node scripts/test_engine.js --theme "gravity" --skip-igdb             # skip IGDB
 *   node scripts/test_engine.js --batch                                   # run test battery
 *
 * Environment:
 *   GEMINI_API_KEY   — required for LLM calls
 *   DATA_DIR         — override data directory
 *   LLM_LOG=1        — show LLM request/response details
 *   ENGINE_LOG=1     — show engine pipeline details
 */

"use strict";

const path = require("path");

// Load .env
try {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
} catch { /* dotenv optional */ }

const engine = require("./inspiration_engine");

const args = process.argv.slice(2);

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--theme" && argv[i + 1])        opts.theme = argv[++i];
    else if (a === "--limitation" && argv[i+1]) opts.limitation = argv[++i];
    else if (a === "--engine" && argv[i + 1])   opts.engine = argv[++i];
    else if (a === "--perspective" && argv[i+1]) opts.perspective = argv[++i];
    else if (a === "--team" && argv[i + 1])     opts.team = argv[++i];
    else if (a === "--scope" && argv[i + 1])    opts.scope = parseInt(argv[++i]);
    else if (a === "--genres" && argv[i + 1])   opts.genres = argv[++i].split(",").map(s => s.trim());
    else if (a === "--limit" && argv[i + 1])    opts.limit = parseInt(argv[++i]);
    else if (a === "--skip-narrator")           opts.skipNarrator = true;
    else if (a === "--skip-igdb")               opts.skipIGDB = true;
    else if (a === "--batch")                   opts.batch = true;
  }
  return opts;
}

// ─── Display ──────────────────────────────────────────────────────────────────

function displayResult(result) {
  const m = result.meta;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Theme: "${m.theme}"${m.limitation ? ` | Limitation: "${m.limitation}"` : ""}`);
  console.log(`${"═".repeat(70)}`);

  // Interpretation
  console.log(`\n  Interpretation (LLM: ${m.interpreterLLM ? "yes" : "fallback"}):`);
  console.log(`    Themes:   ${m.interpretation.themes.join(", ") || "(none)"}`);
  console.log(`    Tags:     ${m.interpretation.tags.join(", ") || "(none)"}`);
  console.log(`    Genres:   ${m.interpretation.genres.join(", ") || "(none)"}`);
  if (m.interpretation.concepts.length) {
    console.log(`    Concepts: ${m.interpretation.concepts.join(", ")}`);
  }

  // Pipeline stats
  console.log(`\n  Pipeline: ${m.candidateCount} candidates → ${m.filteredCount} filtered → ${m.resultCount} results`);
  console.log(`  IGDB: ${m.igdbCount} reference games | Narrator: ${m.narratorLLM ? "LLM" : "fallback"} | Total: ${m.queryTimeMs}ms`);

  // Paths
  if (result.paths.length === 0) {
    console.log(`\n  No inspiration paths generated.`);
    return;
  }

  for (let i = 0; i < result.paths.length; i++) {
    const p = result.paths[i];
    console.log(`\n  ${"─".repeat(60)}`);
    console.log(`  Path ${i + 1}: ${p.name}  [${p.mood}]`);
    console.log(`  ${"─".repeat(60)}`);
    console.log(`  ${p.pitch}`);
    console.log(`  Why: ${p.why_it_fits}`);
    console.log(`  Scope: ${p.scope_hint}`);

    if (p.games && p.games.length > 0) {
      console.log(`\n  Games:`);
      for (const g of p.games) {
        if (g.source === "itch") {
          const rank = g.overallRank ? `#${g.overallRank}` : "?";
          const score = g._score ? ` [${g._score.toFixed(2)}]` : "";
          console.log(`    [itch]${score} ${g.title} — ${g.genres.join("/")} | ${rank} in "${g.jamTheme}"`);
          console.log(`           ${g.gameUrl}`);
        } else if (g.source === "igdb") {
          console.log(`    [IGDB] ${g.title} — ${g.genres.join("/")} | rating: ${g.rating || "?"}`);
          if (g.url) console.log(`           ${g.url}`);
        }
      }
    }
  }

  console.log(`\n${"═".repeat(70)}\n`);
}

// ─── Batch mode ───────────────────────────────────────────────────────────────

const BATCH_QUERIES = [
  { theme: "gravity", skipIGDB: true },
  { theme: "horror", engine: "Godot", perspective: "2d", team: "solo", skipIGDB: true },
  { theme: "time loop", skipIGDB: true },
  { theme: "card game", genres: ["card game", "strategy"], skipIGDB: true },
  { theme: "connected", skipIGDB: true },
  { theme: "Western", limitation: "Everything going wrong", skipIGDB: true },
];

async function runBatch() {
  console.log(`\n  Running ${BATCH_QUERIES.length} batch queries...\n`);

  for (const q of BATCH_QUERIES) {
    try {
      console.log(`\n  >>> Querying: "${q.theme}"${q.limitation ? ` + "${q.limitation}"` : ""} ${q.engine ? `+ ${q.engine}` : ""} ${q.perspective ? `+ ${q.perspective}` : ""} ${q.team ? `+ ${q.team}` : ""}`);
      const result = await engine.query(q);
      displayResult(result);
    } catch (err) {
      console.error(`  ❌ Query "${q.theme}" failed: ${err.message}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(args);

  if (!opts.theme && !opts.batch) {
    console.log("Usage:");
    console.log('  node scripts/test_engine.js --theme "gravity"');
    console.log('  node scripts/test_engine.js --theme "horror" --engine Godot --perspective 2d');
    console.log("  node scripts/test_engine.js --batch");
    console.log("");
    console.log("Options:");
    console.log("  --theme <text>          Theme to search");
    console.log("  --limitation <text>     Optional jam limitation");
    console.log("  --engine <name>         Hard filter: engine");
    console.log("  --perspective <2d|3d>   Hard filter: perspective");
    console.log("  --team <solo|small_team|medium_team|large_team>");
    console.log("  --scope <1-5>           1=seconds, 2=mins, 3=half-hour");
    console.log("  --genres <csv>          Boost these genres");
    console.log("  --skip-narrator         Skip LLM narrator (test retrieval)");
    console.log("  --skip-igdb             Skip IGDB reference games");
    console.log("  --batch                 Run pre-defined test battery");
    return;
  }

  // Init engine (skip IGDB for faster testing unless explicitly wanted)
  const skipIGDB = opts.skipIGDB !== false;
  console.log("Initializing engine...");
  await engine.init({ skipIGDB });

  if (opts.batch) {
    await runBatch();
    return;
  }

  const result = await engine.query(opts);
  displayResult(result);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  if (err.stack && process.env.ENGINE_LOG === "1") console.error(err.stack);
  process.exit(1);
});
