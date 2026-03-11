"use strict";

/**
 * fill_popular_games.js
 *
 * For jams with no games stored (empty topGames), fetches all entries from
 * itch.io, sorts by coolness (itch's popularity metric), takes the top 10,
 * scrapes their details, and writes the result.
 *
 * Usage:
 *   node fill_popular_games.js              # process all empty jams
 *   node fill_popular_games.js --jam <n>    # process one specific jam
 *   node fill_popular_games.js --top <n>    # take top N instead of 10
 *   node fill_popular_games.js --overwrite  # redo jams that already have games
 */

const { getGame } = require("itch-scraper");
const fs          = require("fs/promises");
const path        = require("path");
const https       = require("https");

const OUTPUT_DIR  = path.join("data", "jam_data");
const MERGED_FILE = path.join("data", "jam_data.json");

const REQUEST_DELAY    = 300;   // ms between requests
const MAX_RETRIES      = 2;
const RETRY_BASE_DELAY = 8000;  // ms, doubles per retry

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function argValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const jamFilter = argValue("--jam") !== null ? parseInt(argValue("--jam"), 10) : null;
const topN      = parseInt(argValue("--top") ?? "10", 10);
const overwrite = args.includes("--overwrite");

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJson(url, retries = 0) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      agent: new https.Agent({ keepAlive: true }),
    });
    if (res.status === 429) {
      if (retries >= MAX_RETRIES) throw new Error(`429 after ${MAX_RETRIES} retries: ${url}`);
      const delay = RETRY_BASE_DELAY * Math.pow(2, retries);
      console.warn(`  ⏳ 429 — waiting ${delay / 1000}s`);
      await sleep(delay);
      return fetchJson(url, retries + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
  } finally {
    await sleep(REQUEST_DELAY);
  }
}

async function scrapeGame(url, retries = 0) {
  try {
    const result = await getGame(url);
    if (!result || !result.title) throw new Error("Empty result (page may not have loaded)");
    return result;
  } catch (err) {
    const is429   = err.message?.includes("429") || err.response?.status === 429;
    const isNull  = err.message?.includes("null") || err.message?.includes("textContent");
    const isEmpty = err.message?.includes("Empty result");
    if ((is429 || isNull || isEmpty) && retries < MAX_RETRIES) {
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

// ── Core ──────────────────────────────────────────────────────────────────────

async function fetchTopByPopularity(jamID, n) {
  const data = await fetchJson(`https://itch.io/jam/${jamID}/entries.json`);
  const entries = (data.jam_games ?? []).filter(e => e.game?.id != null && e.game?.url);

  // Sort by rating_count descending, then coolness as tiebreak
  entries.sort((a, b) => {
    const ratingDiff = (b.rating_count ?? 0) - (a.rating_count ?? 0);
    if (ratingDiff !== 0) return ratingDiff;
    return (b.coolness ?? 0) - (a.coolness ?? 0);
  });

  return entries.slice(0, n);
}

async function processJam(jam) {
  const jamID = jam.jamMeta?.jamID;
  if (!jamID) {
    console.log(`  ✗ No jamID — skipping`);
    return false;
  }

  console.log(`\n[${jam.n}] ${jam.name}`);
  console.log(`  Fetching entries for jamID ${jamID}…`);

  let topEntries;
  try {
    topEntries = await fetchTopByPopularity(jamID, topN);
  } catch (err) {
    console.warn(`  ✗ Could not fetch entries: ${err.message}`);
    return false;
  }

  console.log(`  → ${topEntries.length} top entries by popularity`);

  const topGames = [];
  for (let i = 0; i < topEntries.length; i++) {
    const entry   = topEntries[i];
    const gameUrl = entry.game.url;
    console.log(`  [${i + 1}/${topEntries.length}] ${gameUrl}  (ratings: ${entry.rating_count ?? 0}, coolness: ${entry.coolness ?? 0})`);

    let details = null;
    try {
      details = await scrapeGame(gameUrl);
      console.log(`    ✓ "${details.title}"`);
    } catch (err) {
      console.warn(`    ✗ Scrape failed: ${err.message}`);
    }

    topGames.push({
      gameId:        entry.game.id,
      gameUrl,
      overallRank:   i + 1,
      topCategories: [],
      resultData:    null,
      entryData:     entry,
      details,
    });
  }

  const updated = { ...jam, topGames };
  const jamFile = path.join(OUTPUT_DIR, `${jam.n}.json`);
  await fs.writeFile(jamFile, JSON.stringify(updated, null, 2), "utf-8");

  const failed = topGames.filter(g => !g.details).length;
  console.log(`  ✓ Written — ${topGames.length} games, ${failed} scrape failure(s)`);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const raw  = await fs.readFile(MERGED_FILE, "utf-8");
  const jams = JSON.parse(raw);

  let targets = jams.filter(j => {
    if (jamFilter !== null) return j.n === jamFilter;
    const hasGames = Array.isArray(j.topGames) && j.topGames.length > 0;
    return overwrite ? true : !hasGames;
  });

  if (jamFilter !== null && targets.length === 0) {
    console.error(`No jam found with n=${jamFilter}`);
    process.exit(1);
  }

  console.log(`\nFill Popular Games`);
  console.log(`==================`);
  console.log(`Top ${topN} by rating count  |  ${targets.length} jam(s) to process\n`);

  let processed = 0;
  for (const jam of targets) {
    const ok = await processJam(jam);
    if (ok) processed++;
  }

  if (processed > 0) await remerge();

  console.log(`\nDone. ${processed}/${targets.length} jam(s) updated.\n`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
