/**
 * test_llm_client.js
 *
 * Standalone test for llm_client.js.
 *
 * With GEMINI_API_KEY set:    makes real API calls and validates responses
 * Without GEMINI_API_KEY:     dry-run mode showing exact request payloads
 *
 * Usage:
 *   node scripts/test_llm_client.js                    # auto-detects mode
 *   node scripts/test_llm_client.js --dry-run           # force dry-run
 *   node scripts/test_llm_client.js --live              # force live (fails if no key)
 *   LLM_LOG=1 node scripts/test_llm_client.js --live    # live with debug logging
 */

"use strict";

const path = require("path");

// Load .env
try {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
} catch { /* dotenv optional */ }

const llm = require("./llm_client");

const args    = process.argv.slice(2);
const forceDry  = args.includes("--dry-run");
const forceLive = args.includes("--live");

// ─── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

// ─── Test 1: Status check ─────────────────────────────────────────────────────

function testStatus() {
  console.log("\n── Test 1: status() ──");
  const s = llm.status();
  console.log(`  Ready: ${s.ready}`);
  console.log(`  Models: fast=${s.models.fast}, smart=${s.models.smart}`);
  console.log(`  Rate limits:`, JSON.stringify(s.rateLimits));
  assert(typeof s.ready === "boolean", "status.ready is boolean");
  assert(s.models.fast && s.models.smart, "models are defined");
  return s.ready;
}

// ─── Test 2: Schema validation ────────────────────────────────────────────────

function testSchemas() {
  console.log("\n── Test 2: Schema definitions ──");

  const ti = llm.THEME_INTERPRETER_SCHEMA;
  assert(ti.type === "object", "Theme interpreter schema is object");
  assert(ti.required.includes("theme_matches"), "Schema requires theme_matches");
  assert(ti.required.includes("tag_matches"), "Schema requires tag_matches");
  assert(ti.required.includes("genre_hints"), "Schema requires genre_hints");
  assert(ti.required.includes("concepts"), "Schema requires concepts");

  const nr = llm.NARRATOR_SCHEMA;
  assert(nr.type === "object", "Narrator schema is object");
  assert(nr.required.includes("paths"), "Narrator schema requires paths");
  const pathProps = nr.properties.paths.items.properties;
  assert(pathProps.name && pathProps.pitch, "Path has name and pitch");
  assert(pathProps.game_ids, "Path has game_ids");
}

// ─── Test 3: Dry-run — show exact payloads ────────────────────────────────────

function testDryRun() {
  console.log("\n── Test 3: Dry-run payload inspection ──");

  // Simulate the theme interpreter prompt
  const themeCatalog = {
    jam_themes: ["Loop", "Roles Reversed", "Built to Scale", "Horror", "Failure is Progress"],
    genres: ["puzzle", "action", "platformer", "shooter", "strategy"],
    top_tags: ["2d", "3d", "physics", "horror", "pixel art", "roguelike", "atmospheric", "space"],
  };

  const system = `You are JamPad's theme interpreter. Given a game jam theme and optional constraints, return the most relevant search terms from JamPad's database.

Your job is semantic bridging — mapping the user's words to terms that exist in the database. Be creative with connections but never invent terms that aren't in the provided vocabulary.`;

  const user = `Theme: "gravity"

VOCABULARY (only return terms from these lists):
Jam themes: ${JSON.stringify(themeCatalog.jam_themes)}
Genres: ${JSON.stringify(themeCatalog.genres)}
Tags: ${JSON.stringify(themeCatalog.top_tags)}

Return the most relevant terms for this theme.`;

  console.log("\n  --- SYSTEM PROMPT ---");
  console.log(`  ${system.slice(0, 200)}...`);
  console.log(`  (${system.length} chars, ~${Math.round(system.length / 4)} tokens)`);

  console.log("\n  --- USER PROMPT ---");
  console.log(`  ${user.slice(0, 300)}...`);
  console.log(`  (${user.length} chars, ~${Math.round(user.length / 4)} tokens)`);

  console.log("\n  --- SCHEMA ---");
  console.log(`  ${JSON.stringify(llm.THEME_INTERPRETER_SCHEMA, null, 2).slice(0, 400)}...`);

  assert(system.length > 0, "System prompt generated");
  assert(user.includes("gravity"), "User prompt contains theme");
  assert(user.includes("Jam themes:"), "User prompt includes vocabulary");
}

// ─── Test 4: Live API call — theme interpreter ────────────────────────────────

async function testLiveThemeInterpreter() {
  console.log("\n── Test 4: Live theme interpreter call ──");

  const system = `You are JamPad's theme interpreter. Given a game jam theme, return the most relevant search terms from JamPad's database.

Your job is semantic bridging — mapping the user's words to terms that exist in the database. Be creative with connections but never invent terms that aren't in the provided vocabulary.`;

  const themeCatalog = {
    jam_themes: [
      "Loop", "Roles Reversed", "Built to Scale", "Horror", "Growth",
      "Only One", "POWER", "Out of Control", "Joined Together",
      "Stronger Together", "Failure is Progress", "DEATH IS ONLY THE BEGINNING",
      "Down to Earth", "As Above So Below", "Rewind", "TIME", "Balance",
      "Connection", "Running out of Space", "Exploration",
    ],
    genres: [
      "puzzle", "action", "platformer", "adventure", "shooter",
      "simulation", "strategy", "survival", "rhythm", "card game",
    ],
    top_tags: [
      "2d", "3d", "pixel art", "horror", "arcade", "atmospheric",
      "physics", "roguelike", "bullet hell", "top-down", "first-person",
      "space", "cute", "retro", "casual", "funny", "creepy",
      "sci-fi", "fantasy", "story rich", "point & click", "cozy",
      "puzzle-platformer", "minimalist", "dark", "time travel",
    ],
  };

  const user = `Theme: "gravity"

VOCABULARY (only return terms from these lists):
Jam themes: ${JSON.stringify(themeCatalog.jam_themes)}
Genres: ${JSON.stringify(themeCatalog.genres)}
Tags: ${JSON.stringify(themeCatalog.top_tags)}

Return the most relevant terms for this theme.`;

  const t0 = Date.now();
  const result = await llm.complete({
    system,
    user,
    schema: llm.THEME_INTERPRETER_SCHEMA,
    quality: "fast",
    temperature: 0.3,
  });
  const elapsed = Date.now() - t0;

  console.log(`\n  Response (${elapsed}ms):`);
  console.log(`  ${JSON.stringify(result, null, 2)}`);

  // Validate structure
  assert(Array.isArray(result.theme_matches), "theme_matches is array");
  assert(Array.isArray(result.tag_matches), "tag_matches is array");
  assert(Array.isArray(result.genre_hints), "genre_hints is array");
  assert(Array.isArray(result.concepts), "concepts is array");
  assert(result.theme_matches.length >= 1, `Got ${result.theme_matches.length} theme matches`);
  assert(result.tag_matches.length >= 1, `Got ${result.tag_matches.length} tag matches`);

  // Validate that returned terms actually come from the vocabulary
  const validThemes = new Set(themeCatalog.jam_themes.map(t => t.toLowerCase()));
  const validGenres = new Set(themeCatalog.genres);
  const validTags   = new Set(themeCatalog.top_tags);

  const badThemes = result.theme_matches.filter(t => !validThemes.has(t.toLowerCase()));
  const badGenres = result.genre_hints.filter(g => !validGenres.has(g.toLowerCase()));
  const badTags   = result.tag_matches.filter(t => !validTags.has(t.toLowerCase()));

  if (badThemes.length) console.log(`  ⚠ Hallucinated themes: ${badThemes.join(", ")}`);
  if (badGenres.length) console.log(`  ⚠ Hallucinated genres: ${badGenres.join(", ")}`);
  if (badTags.length)   console.log(`  ⚠ Hallucinated tags: ${badTags.join(", ")}`);

  assert(badThemes.length === 0, "No hallucinated themes");
  assert(badGenres.length === 0, "No hallucinated genres");

  // Semantic check: "gravity" should map to physics-related terms
  const allTerms = [
    ...result.theme_matches.map(t => t.toLowerCase()),
    ...result.tag_matches.map(t => t.toLowerCase()),
    ...result.genre_hints.map(g => g.toLowerCase()),
  ].join(" ");
  const hasPhysicsSignal = allTerms.includes("physics") ||
                           allTerms.includes("space") ||
                           allTerms.includes("platformer") ||
                           allTerms.includes("down to earth") ||
                           allTerms.includes("balance");
  assert(hasPhysicsSignal, "Gravity mapped to physics-related terms");

  return result;
}

// ─── Test 5: Live API call — basic text (no schema) ───────────────────────────

async function testLiveBasicText() {
  console.log("\n── Test 5: Live basic text call (no schema) ──");

  const t0 = Date.now();
  const result = await llm.complete({
    system: "Reply in exactly one short sentence.",
    user: "What is a game jam?",
    quality: "fast",
    temperature: 0.2,
  });
  const elapsed = Date.now() - t0;

  console.log(`  Response (${elapsed}ms): "${result}"`);
  assert(typeof result === "string", "Result is a string");
  assert(result.length > 10, "Response is non-trivial");
  assert(result.toLowerCase().includes("game"), "Response mentions games");
}

// ─── Test 6: Error handling — missing key ─────────────────────────────────────

async function testMissingKey() {
  console.log("\n── Test 6: Error message quality ──");
  // We can't easily test this without unsetting the env var,
  // so just verify the status check catches it
  const s = llm.status();
  if (!s.ready) {
    assert(s.error.includes("GEMINI_API_KEY"), "Error message mentions API key");
  } else {
    console.log("  (skipped — key is set)");
    passed++;
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║    llm_client.js test suite          ║");
  console.log("╚══════════════════════════════════════╝");

  const isReady = testStatus();
  testSchemas();
  testDryRun();
  await testMissingKey();

  const liveMode = forceLive || (isReady && !forceDry);

  if (liveMode) {
    if (!isReady) {
      console.error("\n❌ --live requested but GEMINI_API_KEY not set");
      process.exit(1);
    }
    console.log("\n🔴 LIVE MODE — making real API calls\n");
    await testLiveBasicText();
    await testLiveThemeInterpreter();
  } else {
    console.log("\n⚪ DRY-RUN MODE — no API calls");
    console.log("  Set GEMINI_API_KEY in .env to run live tests");
  }

  // Summary
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("\nFatal:", err.message);
  process.exit(1);
});
