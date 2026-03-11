/**
 * verify_jam.js
 *
 * Verifies that a single jam's JSON file is complete and all game data is valid.
 *
 * Usage:
 *   node verify_jam.js <n>
 *
 * Exit codes:
 *   0  all checks passed
 *   1  issues found or file missing / unparseable
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join("data", "jam_data");

// ── CLI ────────────────────────────────────────────────────────────────────────

const n = parseInt(process.argv[2], 10);
if (isNaN(n)) {
  console.error("Usage: node verify_jam.js <n>");
  process.exit(1);
}

// ── Load ───────────────────────────────────────────────────────────────────────

const filePath = path.join(OUTPUT_DIR, `${n}.json`);

if (!fs.existsSync(filePath)) {
  console.error(`\n❌  File not found: ${filePath}\n`);
  process.exit(1);
}

let jam;
try {
  jam = JSON.parse(fs.readFileSync(filePath, "utf-8"));
} catch (err) {
  console.error(`\n❌  Could not parse JSON: ${err.message}\n`);
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const PASS = "  ✓";
const FAIL = "  ✗";
const WARN = "  ⚠";

const failures = [];
const warnings = [];

function ok(label) {
  console.log(`${PASS} ${label}`);
}

function fail(label, detail = "") {
  const msg = detail ? `${label}: ${detail}` : label;
  console.log(`${FAIL} ${msg}`);
  failures.push(msg);
}

function warn(label) {
  console.log(`${WARN} ${label}`);
  warnings.push(label);
}

function check(label, condition, detail = "") {
  condition ? ok(label) : fail(label, detail);
}

// ── Header ─────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`  Jam [${n}]: ${jam.name ?? "(no name)"}`);
console.log(`  Theme:  ${jam.theme ?? "(none)"}`);
console.log(`  URL:    ${jam.url ?? "(none)"}`);
console.log(`${"─".repeat(60)}`);

// ── 1. Jam-level fields ────────────────────────────────────────────────────────

console.log("\n[ Jam metadata ]");
check("name",          !!jam.name);
check("url",           !!jam.url);
check("theme",         !!jam.theme && jam.theme !== "USER TO FILL",
                       jam.theme === "USER TO FILL" ? "theme not filled in" : "");
check("slug",          !!jam.slug);
check("jamMeta",       !!jam.jamMeta && !!jam.jamMeta.jamID,
                       !jam.jamMeta ? "missing" : "jamID missing");
check("totalEntries",  typeof jam.totalEntries === "number" && jam.totalEntries > 0,
                       `got ${jam.totalEntries}`);
check("ranked (bool)", typeof jam.ranked === "boolean");
check("hasCategories", typeof jam.hasCategories === "boolean");
check("categories []", Array.isArray(jam.categories));

// ── 2. Manual-selection shortcut ───────────────────────────────────────────────

if (jam.needsManualSelection) {
  console.log("\n[ Selection mode ]");
  ok("flagged needsManualSelection — game list must be filled manually");

  const hasGames = Array.isArray(jam.topGames) && jam.topGames.length > 0;
  if (hasGames) {
    // They filled it in — fall through to the normal game checks below
    console.log("  → topGames is populated, verifying entries…");
  } else {
    // Nothing to verify
    summary();
    return;
  }
}

// ── 3. topGames array ──────────────────────────────────────────────────────────

console.log("\n[ Game list ]");

const games = jam.topGames ?? [];
check("topGames is an array",  Array.isArray(jam.topGames));
check("topGames non-empty",    games.length > 0, `found ${games.length}`);

if (!games.length) {
  summary();
  return;
}

console.log(`  → ${games.length} game(s) to verify`);

// ── 4. Category coverage (multi-category jams only) ────────────────────────────

if (jam.hasCategories && jam.categories?.length) {
  console.log("\n[ Category coverage ]");

  const topN = jam.totalEntries >= 3000 ? 20
             : jam.totalEntries >= 1000 ? 15
             : 10;

  for (const cat of jam.categories) {
    const count = games.filter(g => g.topCategories?.includes(cat)).length;
    if (count === 0) {
      fail(`"${cat}"`, "no games assigned to this category");
    } else if (count < topN) {
      warn(`"${cat}" has ${count}/${topN} games (ties or filtered entries may reduce count)`);
    } else {
      ok(`"${cat}" — ${count} game(s)`);
    }
  }
}

// ── 5. Per-game checks ─────────────────────────────────────────────────────────

console.log("\n[ Per-game detail ]");

const missingUrl         = [];
const missingRankInfo    = [];
const missingDetails     = [];
const emptyTitle         = [];
const emptyDescription   = [];
const noScreenshots      = [];

for (const game of games) {
  const label = game.gameUrl ?? `gameId:${game.gameId ?? "?"}`;

  if (!game.gameUrl)                        missingUrl.push(label);
  if (game.overallRank == null && !game.topCategories?.length)
                                            missingRankInfo.push(label);
  if (!game.details)                        missingDetails.push(label);
  if (!game.details?.title)                 emptyTitle.push(label);
  if (!game.details?.description)           emptyDescription.push(label);
  if (!game.details?.screenshots?.length)   noScreenshots.push(label);
}

function listIssue(label, arr) {
  if (arr.length === 0) { ok(label); return; }
  fail(label, `${arr.length} game(s):`);
  arr.forEach(u => console.log(`      • ${u}`));
}

listIssue("all games have gameUrl",          missingUrl);
listIssue("all games have rank / category",  missingRankInfo);
listIssue("all games have details",          missingDetails);
listIssue("all games have a title",          emptyTitle);
listIssue("all games have a description",    emptyDescription);

// Screenshots are optional — some games have none intentionally
if (noScreenshots.length > 0) {
  warn(`${noScreenshots.length}/${games.length} game(s) have no screenshots (may be intentional)`);
}

// ── 6. Summary ────────────────────────────────────────────────────────────────

summary();

function summary() {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${games.length} game(s)  |  ${failures.length} failure(s)  |  ${warnings.length} warning(s)`);
  console.log(`${"─".repeat(60)}`);

  if (failures.length === 0) {
    console.log("  ✅  All checks passed.\n");
    process.exit(0);
  } else {
    console.log("  ❌  Verification failed.\n");
    process.exit(1);
  }
}