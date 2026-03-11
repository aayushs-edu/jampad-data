"use strict";

/**
 * verify_all_jams.js
 *
 * Verifies the entire output/jam_data.json file.
 * Reports:
 *   - Jams with no games stored (missing/empty topGames)
 *   - Games with no "details" object
 *
 * Usage:
 *   node verify_all_jams.js
 */

const fs   = require("fs");
const path = require("path");

const JAM_DATA_FILE = path.join(__dirname, "output", "jam_data.json");

// ── Load ───────────────────────────────────────────────────────────────────────

if (!fs.existsSync(JAM_DATA_FILE)) {
  console.error(`\n❌  File not found: ${JAM_DATA_FILE}\n`);
  process.exit(1);
}

let jams;
try {
  jams = JSON.parse(fs.readFileSync(JAM_DATA_FILE, "utf-8"));
} catch (err) {
  console.error(`\n❌  Could not parse JSON: ${err.message}\n`);
  process.exit(1);
}

if (!Array.isArray(jams)) {
  console.error("\n❌  Expected jam_data.json to be an array.\n");
  process.exit(1);
}

// ── Scan ───────────────────────────────────────────────────────────────────────

const jamsWithNoGames   = [];   // { n, name }
const gamesWithNoDetails = [];  // { jamN, jamName, gameUrl }

let totalJams  = jams.length;
let totalGames = 0;

for (const jam of jams) {
  const jamLabel = `[${jam.n ?? "?"}] ${jam.name ?? "(no name)"}`;
  const games    = Array.isArray(jam.topGames) ? jam.topGames : [];

  if (games.length === 0) {
    jamsWithNoGames.push({ n: jam.n, name: jam.name ?? "(no name)" });
    continue;
  }

  totalGames += games.length;

  for (const game of games) {
    if (!game.details) {
      gamesWithNoDetails.push({
        jamN:    jam.n,
        jamName: jam.name ?? "(no name)",
        gameUrl: game.gameUrl ?? `gameId:${game.gameId ?? "?"}`,
      });
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────

const LINE = "─".repeat(64);

console.log(`\n${LINE}`);
console.log(`  JamPad — Full Data Verification`);
console.log(`  ${totalJams} jam(s) loaded  |  ${totalGames} game(s) across populated jams`);
console.log(LINE);

// Jams with no games
console.log(`\n[ Jams with no games stored ]`);
if (jamsWithNoGames.length === 0) {
  console.log("  ✓  All jams have at least one game.");
} else {
  console.log(`  ✗  ${jamsWithNoGames.length} jam(s) are empty:\n`);
  for (const j of jamsWithNoGames) {
    console.log(`      • [${j.n}] ${j.name}`);
  }
}

// Games with no details
console.log(`\n[ Games with no "details" ]`);
if (gamesWithNoDetails.length === 0) {
  console.log("  ✓  All games have details.");
} else {
  console.log(`  ✗  ${gamesWithNoDetails.length} game(s) are missing details:\n`);

  // Group by jam for readability
  const byJam = new Map();
  for (const g of gamesWithNoDetails) {
    const key = `[${g.jamN}] ${g.jamName}`;
    if (!byJam.has(key)) byJam.set(key, []);
    byJam.get(key).push(g.gameUrl);
  }

  for (const [jamLabel, urls] of byJam) {
    console.log(`\n    ${jamLabel} (${urls.length} game(s)):`);
    for (const url of urls) {
      console.log(`      • ${url}`);
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────

const issues = jamsWithNoGames.length + gamesWithNoDetails.length;

console.log(`\n${LINE}`);
console.log(`  ${jamsWithNoGames.length} jam(s) with no games  |  ${gamesWithNoDetails.length} game(s) with no details`);
console.log(LINE);

if (issues === 0) {
  console.log("  ✅  All checks passed.\n");
  process.exit(0);
} else {
  console.log("  ❌  Issues found.\n");
  process.exit(1);
}
