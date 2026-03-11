"use strict";

/**
 * purge_404_games.js
 *
 * Finds all games with no "details" across jam_data.json,
 * checks each URL with a HEAD request, and removes any that return 404.
 *
 * Usage:
 *   node purge_404_games.js          # check and purge
 *   node purge_404_games.js --dry-run  # report only, no writes
 */

const fs   = require("fs/promises");
const path = require("path");

const OUTPUT_DIR  = path.join(__dirname, "output", "jam_data");
const MERGED_FILE = path.join(__dirname, "output", "jam_data.json");

const REQUEST_DELAY = 200;  // ms between requests

const dryRun = process.argv.includes("--dry-run");

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    return res.status;
  } catch (err) {
    return `ERR: ${err.message.slice(0, 60)}`;
  }
}

async function remerge() {
  const files = await fs.readdir(OUTPUT_DIR);
  const allResults = await Promise.all(
    files
      .filter(f => f.endsWith(".json"))
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map(async f => JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, f), "utf-8")))
  );
  await fs.writeFile(MERGED_FILE, JSON.stringify(allResults, null, 2), "utf-8");
  const total = allResults.reduce((s, j) => s + (j.topGames?.length ?? 0), 0);
  console.log(`  ✓ Merged: ${allResults.length} jams, ${total} games → ${MERGED_FILE}`);
}

async function main() {
  const raw  = await fs.readFile(MERGED_FILE, "utf-8");
  const jams = JSON.parse(raw);

  // Collect all games missing details
  const missing = [];
  for (const jam of jams) {
    for (const game of (jam.topGames ?? [])) {
      if (!game.details) {
        missing.push({ jamN: jam.n, gameUrl: game.gameUrl });
      }
    }
  }

  console.log(`\nPurge 404 Games${dryRun ? " [DRY RUN]" : ""}`);
  console.log(`================`);
  console.log(`${missing.length} game(s) with no details to check\n`);

  if (missing.length === 0) {
    console.log("Nothing to do.\n");
    return;
  }

  // Check each URL
  const toDelete   = [];  // { jamN, gameUrl }
  const notFound   = [];  // status !== 200/404 (errors, redirects, etc.)

  for (let i = 0; i < missing.length; i++) {
    const { jamN, gameUrl } = missing[i];
    process.stdout.write(`  [${i + 1}/${missing.length}] ${gameUrl} … `);
    const status = await checkUrl(gameUrl);
    console.log(status);
    if (status === 404) {
      toDelete.push({ jamN, gameUrl });
    } else if (status !== 200) {
      notFound.push({ jamN, gameUrl, status });
    }
    await sleep(REQUEST_DELAY);
  }

  console.log(`\n── Results ──────────────────────────────────────────────`);
  console.log(`  404 (will delete): ${toDelete.length}`);
  console.log(`  Other non-200:     ${notFound.length}`);

  if (notFound.length > 0) {
    console.log(`\n  Non-200 / errors (kept, investigate manually):`);
    for (const { gameUrl, status } of notFound) {
      console.log(`    • ${status}  ${gameUrl}`);
    }
  }

  if (toDelete.length === 0) {
    console.log("\n  No 404s found — nothing deleted.\n");
    return;
  }

  console.log(`\n  404 games to remove:`);
  for (const { jamN, gameUrl } of toDelete) {
    console.log(`    • [${jamN}] ${gameUrl}`);
  }

  if (dryRun) {
    console.log("\n[dry-run] No files written.\n");
    return;
  }

  // Build a set of URLs to delete per jam
  const deleteByJam = new Map();
  for (const { jamN, gameUrl } of toDelete) {
    if (!deleteByJam.has(jamN)) deleteByJam.set(jamN, new Set());
    deleteByJam.get(jamN).add(gameUrl);
  }

  // Update each affected per-jam file
  for (const [jamN, urls] of deleteByJam) {
    const jamFile = path.join(OUTPUT_DIR, `${jamN}.json`);
    const jam     = JSON.parse(await fs.readFile(jamFile, "utf-8"));
    const before  = jam.topGames.length;
    jam.topGames  = jam.topGames.filter(g => !urls.has(g.gameUrl));
    await fs.writeFile(jamFile, JSON.stringify(jam, null, 2), "utf-8");
    console.log(`  ✓ [${jamN}] ${jam.name}: ${before} → ${jam.topGames.length} games`);
  }

  await remerge();
  console.log(`\nDone. ${toDelete.length} game(s) purged.\n`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
