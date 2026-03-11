/**
 * JamPad Dataset Collector
 *
 * For each jam in jam_themes.json:
 *   1. Fetches jam metadata via Itchy (TasfiqulTapu/Itchy)
 *   2. Fetches results.json + entries.json by jamID from Itchy output
 *   3. Selects top N games per category (or overall) and scrapes them via itch-scraper
 *   4. Writes each completed jam to output/jam_data/<n>.json immediately (resume-safe)
 *   5. Merges all per-jam files into output/jam_data.json at the end
 *
 * Install: npm install TasfiqulTapu/itchy itch-scraper p-limit@4
 * Usage:   node collect_jam_data.js [--dry-run] [--jam <n>]
 *
 * Resume: re-running skips jams whose output file already has complete game data.
 * To reprocess a jam, delete output/jam_data/<n>.json and re-run.
 */

"use strict";

const { getJamData } = require("itchy");
const { getGame }    = require("itch-scraper");
const fs             = require("fs/promises");
const path           = require("path");
const https          = require("https");
const pLimit         = require("p-limit").default;

// ─── Config ───────────────────────────────────────────────────────────────────

const INPUT_FILE  = "./jam_themes.json";
const OUTPUT_DIR  = "./output/jam_data";
const MERGED_FILE = "./output/jam_data.json";

// All requests share one queue — this is the only concurrency knob needed.
// At 1, requests are fully serialised. Raise carefully if you want more speed.
const REQUEST_CONCURRENCY = 3;

// Delay between every request (ms). This is the primary rate-limit defence.
const REQUEST_DELAY = 100;

// On 429 or parse errors, retry with exponential backoff.
const MAX_RETRIES       = 1;
const RETRY_BASE_DELAY  = 5000; // 15s, doubles each retry: 15s, 30s, 60s...

// How many jams to process concurrently at the top level.
// Keep at 1 so the request queue isn't shared across concurrent jams.
const JAM_CONCURRENCY = 1;

// ─── Request queue ────────────────────────────────────────────────────────────

const queue = pLimit(REQUEST_CONCURRENCY);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * All HTTP requests go through here.
 * Enforces delay after every request and retries on 429.
 */
async function queuedFetch(url, retries = 0) {
  return queue(async () => {
    try {
      const res = await fetch(url, {
        agent: new https.Agent({ keepAlive: true }),
      });
      if (res.status === 429) {
        if (retries >= MAX_RETRIES) throw new Error(`429 after ${MAX_RETRIES} retries: ${url}`);
        const delay = RETRY_BASE_DELAY * Math.pow(2, retries);
        console.warn(`  ⏳ 429 — waiting ${delay / 1000}s (retry ${retries + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        return queuedFetch(url, retries + 1);
      }
      return res;
    } finally {
      await sleep(REQUEST_DELAY);
    }
  });
}

/**
 * Wraps getGame() in the queue with delay and retry on 429 or null-parse errors.
 */
async function queuedGetGame(url, retries = 0) {
  return queue(async () => {
    try {
      const result = await getGame(url);
      // itch-scraper returns an object — if title is empty the page didn't load right
      if (!result || !result.title) {
        throw new Error(`Empty result for ${url} (page may not have loaded correctly)`);
      }
      return result;
    } catch (err) {
      const is429    = err.message?.includes("429") || err.response?.status === 429;
      const isNull   = err.message?.includes("null") || err.message?.includes("textContent");
      const isEmpty  = err.message?.includes("Empty result");
      if ((is429 || isNull || isEmpty) && retries < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, retries);
        console.warn(`  ⏳ Scrape failed (${err.message.slice(0, 60)}) — waiting ${delay / 1000}s (retry ${retries + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        return queuedGetGame(url, retries + 1);
      }
      throw err;
    } finally {
      await sleep(REQUEST_DELAY);
    }
  });
}

/**
 * Wraps getJamData() in the queue with delay.
 */
async function queuedGetJamData(url) {
  return queue(async () => {
    try {
      return await getJamData(url);
    } finally {
      await sleep(REQUEST_DELAY);
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugFromUrl(url) {
  return url.replace(/\/$/, "").split("/").pop();
}

function topNForEntryCount(entryCount) {
  if (entryCount >= 1000) return 20;
  if (entryCount >= 500) return 15;
  return 10;
}

function jamOutputPath(n) {
  return path.join(OUTPUT_DIR, `${n}.json`);
}

async function jamAlreadyDone(n) {
  try {
    const raw  = await fs.readFile(jamOutputPath(n), "utf-8");
    const data = JSON.parse(raw);
    if (data.needsManualSelection) return true;
    const games = data.topGames ?? [];
    return games.length > 0;
  } catch {
    return false;
  }
}

async function writeJamResult(result) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(jamOutputPath(result.n), JSON.stringify(result, null, 2), "utf-8");
}

// ─── itch.io data fetchers ────────────────────────────────────────────────────

async function fetchEntriesMap(jamID) {
  const res = await queuedFetch(`https://itch.io/jam/${jamID}/entries.json`);
  if (!res.ok) throw new Error(`entries.json fetch failed (${res.status})`);
  const data = await res.json();
  const map  = new Map();
  for (const entry of (data.jam_games ?? [])) {
    if (entry.game?.id != null) map.set(entry.game.id, entry);
  }
  return { map, totalEntries: data.jam_games?.length ?? 0 };
}

async function fetchResults(jamID) {
  const res = await queuedFetch(`https://itch.io/jam/${jamID}/results.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`results.json fetch failed (${res.status})`);
  const data = await res.json();
  return (data.results ?? []).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}

async function fetchTopEntries(jamID) {
  // Fetch sequentially (both go through the queue anyway, but avoid Promise.all
  // firing two slots at once even within the same jam)
  const resultsRaw                        = await fetchResults(jamID);
  const { map: entriesMap, totalEntries } = await fetchEntriesMap(jamID);

  const ranked = resultsRaw !== null;
  if (!ranked) {
    return { ranked: false, hasCategories: false, needsManualSelection: true,
             totalEntries, categories: [], topEntries: [] };
  }

  const resultById = new Map();
  for (const result of resultsRaw) {
    const entry = entriesMap.get(result.id) ?? null;
    if (entry?.game?.url) resultById.set(result.id, { resultData: result, entryData: entry });
  }

  const SKIP_CRITERIA = /favourites?|special|host.?pick/i;
  const allCriteria   = new Set();
  for (const result of resultsRaw) {
    for (const c of (result.criteria ?? [])) {
      if (!SKIP_CRITERIA.test(c.name) && c.score > 0) allCriteria.add(c.name);
    }
  }

  const categories    = [...allCriteria];
  const hasCategories = categories.length > 1;
  const gameTopCategories = new Map();

  if (hasCategories) {
    for (const categoryName of categories) {
      const sorted = resultsRaw
        .filter((r) => {
          const c = (r.criteria ?? []).find((c) => c.name === categoryName);
          return c && c.score > 0;
        })
        .sort((a, b) => {
          const rA = (a.criteria.find((c) => c.name === categoryName)?.rank) ?? Infinity;
          const rB = (b.criteria.find((c) => c.name === categoryName)?.rank) ?? Infinity;
          return rA - rB;
        });
      for (const result of sorted.slice(0, topNForEntryCount(totalEntries))) {
        if (!resultById.has(result.id)) continue;
        if (!gameTopCategories.has(result.id)) gameTopCategories.set(result.id, new Set());
        gameTopCategories.get(result.id).add(categoryName);
      }
    }
  } else {
    for (const result of resultsRaw.slice(0, topNForEntryCount(totalEntries))) {
      if (!resultById.has(result.id)) continue;
      gameTopCategories.set(result.id, new Set(["overall"]));
    }
  }

  const topEntries = [...gameTopCategories.entries()].map(([gameId, cats]) => {
    const { resultData, entryData } = resultById.get(gameId);
    return {
      gameId,
      gameUrl: entryData.game.url,
      overallRank: resultData.rank ?? null,
      topCategories: [...cats],
      resultData,
      entryData,
    };
  });

  return { ranked, hasCategories, needsManualSelection: false, totalEntries, categories, topEntries };
}

// ─── Core logic per jam ───────────────────────────────────────────────────────

async function processJam(jam, dryRun) {
  const { n, name, url, theme } = jam;
  const slug = slugFromUrl(url);

  if (!dryRun && await jamAlreadyDone(n)) {
    console.log(`[${n}] ${name} — already done, skipping`);
    return null;
  }

  console.log(`\n[${n}] ${name} (${slug}) — theme: "${theme}"`);

  // 1. Jam metadata
  let jamMeta = null;
  try {
    jamMeta = await queuedGetJamData(url);
    console.log(`  ✓ Jam meta (type: ${jamMeta.jamType})`);
  } catch (err) {
    console.warn(`  ⚠️  Itchy failed: ${err.message}`);
  }

  // 2. Top entries
  let ranked = false, hasCategories = false, needsManualSelection = false;
  let totalEntries = 0, categories = [], topEntries = [];

  try {
    if (!jamMeta?.jamID) throw new Error("No jamID from Itchy output");
    const r = await fetchTopEntries(jamMeta.jamID);
    ({ ranked, hasCategories, needsManualSelection, totalEntries, categories, topEntries } = r);

    if (needsManualSelection) {
      console.log(`  ⚠️  Non-ranked — top games must be selected manually`);
    } else if (hasCategories) {
      console.log(`  ✓ ${totalEntries} entries, [${categories.join(", ")}], ${topEntries.length} games to scrape`);
    } else {
      console.log(`  ✓ ${totalEntries} entries, scraping top ${topEntries.length}`);
    }
  } catch (err) {
    console.warn(`  ⚠️  Could not fetch entries: ${err.message}`);
  }

  if (dryRun) {
    return { n, name, url, theme, slug, jamMeta, totalEntries, ranked,
             hasCategories, needsManualSelection, categories,
             topGames: topEntries.map((e) => ({ ...e, details: "__dry_run__" })) };
  }

  if (needsManualSelection) {
    const result = { n, name, url, theme, slug, jamMeta, totalEntries, ranked,
                     hasCategories, needsManualSelection, categories, topGames: [] };
    await writeJamResult(result);
    return result;
  }

  // 3. Scrape game details — strictly serialised through the global queue
  const topGames = [];
  for (let i = 0; i < topEntries.length; i++) {
    const entry = topEntries[i];
    console.log(`  → [${i + 1}/${topEntries.length}] ${entry.gameUrl}`);
    let details = null;
    try {
      details = await queuedGetGame(entry.gameUrl);
    } catch (err) {
      console.warn(`  ⚠️  Giving up on ${entry.gameUrl}: ${err.message}`);
    }
    topGames.push({ ...entry, details });
  }

  const result = { n, name, url, theme, slug, jamMeta, totalEntries, ranked,
                   hasCategories, needsManualSelection, categories, topGames };
  await writeJamResult(result);
  console.log(`  ✓ Written to ${jamOutputPath(n)}`);
  return result;
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const dryRun    = args.includes("--dry-run");
const jamFilter = (() => {
  const idx = args.indexOf("--jam");
  return idx !== -1 ? Number(args[idx + 1]) : null;
})();

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("JamPad Dataset Collector");
  console.log("========================");
  if (dryRun) console.log("DRY RUN — no files will be written.\n");

  const raw = await fs.readFile(INPUT_FILE, "utf-8");
  let jams  = JSON.parse(raw);

  if (jamFilter !== null) {
    jams = jams.filter((j) => j.n === jamFilter);
    if (jams.length === 0) { console.error(`No jam found with n=${jamFilter}`); process.exit(1); }
  }

  const alreadyDone = dryRun ? 0 :
    (await Promise.all(jams.map((j) => jamAlreadyDone(j.n)))).filter(Boolean).length;

  console.log(`${jams.length} jams total — ${alreadyDone} already done, ${jams.length - alreadyDone} to process\n`);

  const jamLimit = pLimit(JAM_CONCURRENCY);
  const results  = (await Promise.all(
    jams.map((jam) => jamLimit(() => processJam(jam, dryRun)))
  )).filter(Boolean);

  if (!dryRun) {
    // Merge all per-jam files
    await fs.mkdir(path.dirname(MERGED_FILE), { recursive: true });
    const files = await fs.readdir(OUTPUT_DIR);
    const allResults = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .sort((a, b) => parseInt(a) - parseInt(b))
        .map(async (f) => JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, f), "utf-8")))
    );
    await fs.writeFile(MERGED_FILE, JSON.stringify(allResults, null, 2), "utf-8");
    const totalGames = allResults.reduce((s, j) => s + (j.topGames?.length ?? 0), 0);
    console.log(`\n✅ Done. ${allResults.length} jams, ${totalGames} games.`);
    console.log(`   Per-jam: ${OUTPUT_DIR}/<n>.json`);
    console.log(`   Merged:  ${MERGED_FILE}`);
  } else {
    console.log("\n[dry-run] Preview:");
    console.log(JSON.stringify(results.slice(0, 1), null, 2));
  }
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });