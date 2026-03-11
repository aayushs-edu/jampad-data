"use strict";

/**
 * least_games.js
 *
 * Lists jams sorted by number of stored games (ascending).
 *
 * Usage:
 *   node scripts/least_games.js          # show all jams
 *   node scripts/least_games.js --top 20 # show only bottom N
 */

const fs   = require("fs/promises");
const path = require("path");

const JAM_DIR = path.join("data", "jam_data");

const args = process.argv.slice(2);
const topN = args.includes("--top") ? parseInt(args[args.indexOf("--top") + 1], 10) : null;

async function main() {
  const files = (await fs.readdir(JAM_DIR))
    .filter(f => f.endsWith(".json"))
    .sort((a, b) => parseInt(a) - parseInt(b));

  const jams = await Promise.all(
    files.map(f => fs.readFile(path.join(JAM_DIR, f), "utf-8").then(JSON.parse))
  );

  const rows = jams
    .map(j => ({ n: j.n, name: j.name, count: (j.topGames ?? []).length }))
    .sort((a, b) => a.count - b.count);

  const display = topN !== null ? rows.slice(0, topN) : rows;
  const label   = topN !== null ? `Bottom ${topN} jams` : `All ${rows.length} jams`;

  console.log(`\nGames Stored — ${label} (sorted ascending)\n`);
  console.log(`  ${"#".padEnd(5)} ${"Games".padEnd(7)} Name`);
  console.log(`  ${"-".repeat(50)}`);
  for (const { n, name, count } of display) {
    console.log(`  ${String(n).padEnd(5)} ${String(count).padEnd(7)} ${name}`);
  }
  console.log();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
