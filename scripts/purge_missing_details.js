"use strict";

/**
 * purge_missing_details.js
 *
 * Removes all games that still have no "details" from the dataset.
 *
 * Usage:
 *   node purge_missing_details.js
 *   node purge_missing_details.js --dry-run
 */

const fs   = require("fs/promises");
const path = require("path");

const OUTPUT_DIR  = path.join(__dirname, "output", "jam_data");
const MERGED_FILE = path.join(__dirname, "output", "jam_data.json");

const dryRun = process.argv.includes("--dry-run");

async function remerge() {
  const files = await fs.readdir(OUTPUT_DIR);
  const all = await Promise.all(
    files
      .filter(f => f.endsWith(".json"))
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map(async f => JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, f), "utf-8")))
  );
  await fs.writeFile(MERGED_FILE, JSON.stringify(all, null, 2), "utf-8");
  const total = all.reduce((s, j) => s + (j.topGames?.length ?? 0), 0);
  console.log(`  ✓ Merged: ${all.length} jams, ${total} games → ${MERGED_FILE}`);
}

async function main() {
  const raw  = await fs.readFile(MERGED_FILE, "utf-8");
  const jams = JSON.parse(raw);

  const affected = jams.filter(j => (j.topGames ?? []).some(g => !g.details));
  const total    = affected.reduce((s, j) => s + j.topGames.filter(g => !g.details).length, 0);

  console.log(`\nPurge Missing Details${dryRun ? " [DRY RUN]" : ""}`);
  console.log(`=====================`);
  console.log(`${total} game(s) to remove across ${affected.length} jam(s)\n`);

  if (total === 0) { console.log("Nothing to do.\n"); return; }

  for (const jam of affected) {
    const toRemove = jam.topGames.filter(g => !g.details);
    console.log(`  [${jam.n}] ${jam.name}`);
    for (const g of toRemove) console.log(`    • ${g.gameUrl}`);

    if (!dryRun) {
      jam.topGames = jam.topGames.filter(g => !!g.details);
      await fs.writeFile(
        path.join(OUTPUT_DIR, `${jam.n}.json`),
        JSON.stringify(jam, null, 2),
        "utf-8"
      );
    }
  }

  if (dryRun) { console.log("\n[dry-run] No files written.\n"); return; }

  await remerge();
  console.log(`\nDone. ${total} game(s) removed.\n`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
