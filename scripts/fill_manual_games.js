"use strict";

/**
 * fill_manual_games.js
 *
 * Populates topGames for a jam that announced winners manually
 * (no itch.io results.json). Scrapes each provided URL, assigns
 * ranks by position in the list, then writes the per-jam file
 * and re-merges output/jam_data.json.
 *
 * Usage:
 *   node fill_manual_games.js --jam <n> <url1> <url2> ...
 *   node fill_manual_games.js --jam <n> --file urls.txt
 *
 * The URLs file should have one itch.io game URL per line.
 * Lines starting with # and blank lines are ignored.
 *
 * Options:
 *   --overwrite   Replace existing topGames even if already populated
 */

const { getGame } = require("itch-scraper");
const fs          = require("fs/promises");
const path        = require("path");

const OUTPUT_DIR  = path.join("data", "jam_data");
const MERGED_FILE = path.join("data", "jam_data.json");

const REQUEST_DELAY     = 300;  // ms between scrapes
const MAX_RETRIES       = 2;
const RETRY_BASE_DELAY  = 8000; // ms, doubles per retry

// ── CLI parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function argValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const jamN     = parseInt(argValue("--jam") ?? "", 10);
const urlsFile = argValue("--file");
const overwrite = args.includes("--overwrite");

if (isNaN(jamN)) {
  console.error("Usage: node fill_manual_games.js --jam <n> [--file urls.txt | <url1> <url2> ...]");
  process.exit(1);
}

// Collect URLs: either from --file or remaining positional args
async function collectUrls() {
  if (urlsFile) {
    const raw = await fs.readFile(urlsFile, "utf-8");
    return raw.split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"));
  }
  // Positional args = everything that isn't a flag or flag value
  const flagsWithValues = new Set(["--jam", "--file"]);
  const urlList = [];
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValues.has(args[i])) { i++; continue; }
    if (args[i].startsWith("--")) continue;
    urlList.push(args[i]);
  }
  return urlList;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function scrapeGame(url, retries = 0) {
  try {
    const result = await getGame(url);
    if (!result || !result.title) throw new Error(`Empty result (page may not have loaded)`);
    return result;
  } catch (err) {
    const is429   = err.message?.includes("429") || err.response?.status === 429;
    const isNull  = err.message?.includes("null") || err.message?.includes("textContent");
    const isEmpty = err.message?.includes("Empty result");
    if ((is429 || isNull || isEmpty) && retries < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, retries);
      console.warn(`  ⏳ Retrying ${url} in ${delay / 1000}s (${err.message.slice(0, 60)})`);
      await sleep(delay);
      return scrapeGame(url, retries + 1);
    }
    throw err;
  }
}

// ── Re-merge all per-jam files into jam_data.json ─────────────────────────────

async function remerge() {
  const files = await fs.readdir(OUTPUT_DIR);
  const allResults = await Promise.all(
    files
      .filter(f => f.endsWith(".json"))
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map(async f => JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, f), "utf-8")))
  );
  await fs.writeFile(MERGED_FILE, JSON.stringify(allResults, null, 2), "utf-8");
  const totalGames = allResults.reduce((s, j) => s + (j.topGames?.length ?? 0), 0);
  console.log(`  ✓ Merged: ${allResults.length} jams, ${totalGames} games → ${MERGED_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const urls = await collectUrls();
  if (urls.length === 0) {
    console.error("No URLs provided. Pass them as arguments or use --file urls.txt");
    process.exit(1);
  }

  // Load existing jam file
  const jamFile = path.join(OUTPUT_DIR, `${jamN}.json`);
  let jam;
  try {
    jam = JSON.parse(await fs.readFile(jamFile, "utf-8"));
  } catch {
    console.error(`❌  Could not read ${jamFile}`);
    process.exit(1);
  }

  const existingGames = Array.isArray(jam.topGames) ? jam.topGames : [];

  if (existingGames.length > 0 && !overwrite) {
    console.log(`⚠️  Jam [${jamN}] already has ${existingGames.length} game(s). Use --overwrite to replace.`);
    process.exit(0);
  }

  console.log(`\nFilling games for: [${jamN}] ${jam.name ?? "(no name)"}`);
  console.log(`${urls.length} URL(s) to scrape\n`);

  const topGames = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`  [${i + 1}/${urls.length}] ${url}`);

    let details = null;
    try {
      details = await scrapeGame(url);
      console.log(`    ✓ "${details.title}"`);
    } catch (err) {
      console.warn(`    ✗ Failed: ${err.message}`);
    }

    topGames.push({
      gameId:         details?.id ?? null,
      gameUrl:        url,
      overallRank:    i + 1,
      topCategories:  [],
      resultData:     null,
      entryData:      null,
      details,
    });

    if (i < urls.length - 1) await sleep(REQUEST_DELAY);
  }

  // Write updated jam file
  const updated = { ...jam, topGames };
  await fs.writeFile(jamFile, JSON.stringify(updated, null, 2), "utf-8");
  console.log(`\n  ✓ Written: ${jamFile}`);

  // Re-merge
  await remerge();

  const failed = topGames.filter(g => !g.details).length;
  console.log(`\n${topGames.length} game(s) added  |  ${failed} scrape failure(s)\n`);
  if (failed > 0) {
    console.log("Failed games (details = null):");
    topGames.filter(g => !g.details).forEach(g => console.log(`  • ${g.gameUrl}`));
    console.log();
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
