"use strict";

/**
 * fill_details.js
 *
 * Finds all games with no "details" across jam_data.json,
 * scrapes them, and writes the results back.
 *
 * Usage:
 *   node fill_details.js              # fill all missing details
 *   node fill_details.js --jam <n>    # only for one jam
 */

const { getGame } = require("itch-scraper");
const fs          = require("fs/promises");
const path        = require("path");

const OUTPUT_DIR  = path.join("data", "jam_data");
const MERGED_FILE = path.join("data", "jam_data.json");

const REQUEST_DELAY    = 300;
const MAX_RETRIES      = 2;
const RETRY_BASE_DELAY = 8000;

const args      = process.argv.slice(2);
const jamFilter = args.includes("--jam") ? parseInt(args[args.indexOf("--jam") + 1], 10) : null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeGame(url, retries = 0) {
  try {
    const result = await getGame(url);
    if (!result || !result.title) throw new Error("Empty result");
    return result;
  } catch (err) {
    const retriable = err.message?.includes("429") || err.message?.includes("null")
                   || err.message?.includes("textContent") || err.message?.includes("Empty");
    if (retriable && retries < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, retries);
      console.warn(`    ⏳ Retrying in ${delay / 1000}s (${err.message.slice(0, 60)})`);
      await sleep(delay);
      return scrapeGame(url, retries + 1);
    }
    throw err;
  } finally {
    await sleep(REQUEST_DELAY);
  }
}

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

  // Collect jams that have at least one game missing details or moreInfo
  const needsScrape = g => !g.details || !g.details.moreInfo;
  const targets = jams.filter(j => {
    if (jamFilter !== null && j.n !== jamFilter) return false;
    return (j.topGames ?? []).some(needsScrape);
  });

  const totalMissing = targets.reduce((s, j) => s + j.topGames.filter(needsScrape).length, 0);

  console.log(`\nFill Details`);
  console.log(`============`);
  console.log(`${totalMissing} game(s) missing details across ${targets.length} jam(s)\n`);

  if (totalMissing === 0) { console.log("Nothing to do.\n"); return; }

  let filled = 0, failed = 0;

  for (const jam of targets) {
    const missing = jam.topGames.filter(needsScrape);
    console.log(`[${jam.n}] ${jam.name} — ${missing.length} game(s) to scrape`);

    for (const game of missing) {
      process.stdout.write(`  → ${game.gameUrl} … `);
      try {
        game.details = await scrapeGame(game.gameUrl);
        console.log(`✓ "${game.details.title}"`);
        filled++;
      } catch (err) {
        console.log(`✗ ${err.message.slice(0, 80)}`);
        failed++;
      }
    }

    const jamFile = path.join(OUTPUT_DIR, `${jam.n}.json`);
    await fs.writeFile(jamFile, JSON.stringify(jam, null, 2), "utf-8");
    console.log(`  ✓ Written: ${jamFile}\n`);
  }

  await remerge();
  console.log(`\nDone. ${filled} filled, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
