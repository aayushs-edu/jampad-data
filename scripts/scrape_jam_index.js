/**
 * scrape_jam_index.js
 *
 * Paginates itch.io/jams/past (sorted by most submissions) to build a catalog
 * of jam slugs, names, submission counts, and ranked status.
 *
 * This is Phase 1 of the theme harvesting pipeline:
 *   Phase 1: scrape_jam_index.js   → data/jam_catalog_raw.json  (this script)
 *   Phase 2: extract_jam_themes.js → data/jam_catalog.json       (adds themes)
 *   Phase 3: collect_jam_data.js   → per-jam game data            (existing)
 *
 * Uses the same infrastructure as collect_jam_data.js:
 *   - p-limit queue with shared concurrency
 *   - cheerio for HTML parsing
 *   - 429 retry with exponential backoff
 *   - Incremental writes (resume-safe)
 *
 * Install (if not already):
 *   npm install cheerio p-limit@4
 *
 * Usage:
 *   node scripts/scrape_jam_index.js                  # scrape all pages
 *   node scripts/scrape_jam_index.js --pages 10       # first 10 pages only
 *   node scripts/scrape_jam_index.js --min-subs 20    # stop when subs drop below 20
 *   node scripts/scrape_jam_index.js --ranked-only    # only ranked jams
 *   node scripts/scrape_jam_index.js --start-page 3    # start from page 3 (skip first 2 pages)
 *   node scripts/scrape_jam_index.js --resume         # continue from last page
 *   node scripts/scrape_jam_index.js --dry-run        # print stats, don't write
 */

"use strict";

const fs      = require("fs/promises");
const path    = require("path");
const https   = require("https");
const cheerio = require("cheerio");
const pLimit  = require("p-limit").default;

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL    = "https://itch.io/jams/past/sort-submissions";
const OUTPUT_FILE = path.resolve(__dirname, "../data/jam_catalog_raw.json");

const REQUEST_DELAY    = 500;   // ms between requests
const MAX_RETRIES      = 2;
const RETRY_BASE_DELAY = 8000;  // ms, doubles per retry

const queue = pLimit(1); // fully serialised — one page at a time

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function argValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const maxPages   = argValue("--pages") ? parseInt(argValue("--pages")) : null;
const minSubs    = argValue("--min-subs") ? parseInt(argValue("--min-subs")) : 0;
const startPageArg = argValue("--start-page") ? parseInt(argValue("--start-page")) : null;
const rankedOnly = args.includes("--ranked-only");
const dryRun     = args.includes("--dry-run");
const doResume   = args.includes("--resume");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch with retry on 429 / 5xx.
 * Same pattern as collect_jam_data.js queuedFetch.
 */
async function queuedFetch(url, retries = 0) {
  return queue(async () => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; JamPad/1.0)" },
        agent: new https.Agent({ keepAlive: true }),
      });
      if (res.status === 429 || res.status >= 500) {
        if (retries >= MAX_RETRIES) throw new Error(`${res.status} after ${MAX_RETRIES} retries: ${url}`);
        const delay = RETRY_BASE_DELAY * Math.pow(2, retries);
        console.warn(`  ⏳ ${res.status} — waiting ${delay / 1000}s (retry ${retries + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        return queuedFetch(url, retries + 1);
      }
      return res;
    } finally {
      await sleep(REQUEST_DELAY);
    }
  });
}

// ─── HTML parsing with cheerio ────────────────────────────────────────────────

/**
 * Parse a jam listing page.
 *
 * The itch jam browse page lists jams in repeated blocks. Each block
 * contains an <a href="/jam/{slug}"> inside an <h3>, followed by
 * text with "Hosted by", "X joined", "Y submissions", "Ranked", etc.
 *
 * We use cheerio to find all jam links, then extract metadata from
 * the surrounding text content of the parent container.
 */
function parseJamListPage(html) {
  const $ = cheerio.load(html);
  const jams = [];

  // Find every jam heading link
  $("a[href^='/jam/']").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href") || "";

    // Only match direct jam links (not /jam/xxx/entries, /jam/xxx/results, etc.)
    if (!/^\/jam\/[^/]+\/?$/.test(href)) return;

    // Skip if inside a small element (e.g. "View results" links)
    // The jam name link is typically inside an h3 or is the primary link
    const isHeading = $a.closest("h3").length > 0;
    const isMainLink = $a.text().trim().length > 5; // jam names are longer than "View results"
    if (!isHeading && !isMainLink) return;

    const slug = href.replace("/jam/", "").replace(/\/$/, "");
    const name = $a.text().trim();
    if (!slug || !name) return;

    // Avoid duplicates (same slug already parsed)
    if (jams.some(j => j.slug === slug)) return;

    const url = `https://itch.io/jam/${slug}`;

    // Walk up to the jam's container block and grab all its text.
    // itch.io structure: div.jam.lazy_images > div.padded_content > div.jam_top_row > div.primary_info > h3 > <a>
    // .jam_stats (submissions) is a sibling of .jam_top_row, so we must reach div.jam or div.padded_content.
    let $block = $a.closest(".jam").first();
    if (!$block.length) $block = $a.closest(".padded_content").first();
    if (!$block.length) $block = $a.parent().parent().parent().parent().parent(); // 5 levels up to div.jam
    const blockText = $block.text() || "";

    // Submissions
    const subsMatch = blockText.match(/([\d,]+)\s*submissions?/i);
    const submissions = subsMatch ? parseInt(subsMatch[1].replace(/,/g, "")) : 0;

    // Joined
    const joinedMatch = blockText.match(/([\d,.]+k?)\s*joined/i);
    let joined = 0;
    if (joinedMatch) {
      const raw = joinedMatch[1].replace(/,/g, "");
      joined = raw.toLowerCase().includes("k")
        ? Math.round(parseFloat(raw) * 1000)
        : parseInt(raw);
    }

    // Ranked
    const ranked = /\bRanked\b/i.test(blockText) && !/\bUnranked\b/i.test(blockText);

    // Featured
    const featured = /\bFeatured\b/i.test(blockText);

    // Host: find "Hosted by" links within the block
    const hostNames = [];
    $block.find("a").each((_, hostEl) => {
      const hostHref = $(hostEl).attr("href") || "";
      const hostText = $(hostEl).text().trim();
      // Host links point to user profiles (https://xxx.itch.io)
      if (hostHref.match(/^https:\/\/[^/]+\.itch\.io\/?$/) && hostText.length > 0) {
        hostNames.push(hostText);
      }
    });
    const host = hostNames.length > 0 ? hostNames.join(", ") : "Unknown";

    // End date
    const dateMatch = blockText.match(/(\d{4}-\d{2}-\d{2}T[\d:]+Z)/);
    const endDate = dateMatch ? dateMatch[1] : null;

    jams.push({ slug, name, url, host, submissions, joined, ranked, featured, endDate });
  });

  return jams;
}

/**
 * Extract total page count from pagination ("Page X of Y").
 */
function parseTotalPages(html) {
  const match = html.match(/Page\s+\d+\s+of\s+([\d,]+)/);
  return match ? parseInt(match[1].replace(/,/g, "")) : null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Jam Index Scraper");
  console.log("=================");
  console.log(`Source: ${BASE_URL}`);
  if (dryRun)     console.log("Mode: DRY RUN — no files will be written.");
  if (rankedOnly) console.log("Filter: ranked jams only");
  if (minSubs > 0) console.log(`Filter: min ${minSubs} submissions`);
  if (maxPages)   console.log(`Limit: ${maxPages} pages`);
  console.log();

  // Resume support
  let allJams = [];
  const existingSlugs = new Set();
  let startPage = startPageArg ?? 1;

  if (doResume) {
    try {
      const existing = JSON.parse(await fs.readFile(OUTPUT_FILE, "utf-8"));
      allJams = existing;
      for (const j of existing) existingSlugs.add(j.slug);
      // itch.io shows ~50 jams per page
      if (!startPageArg) startPage = Math.max(1, Math.floor(existing.length / 50));
      console.log(`Resuming: ${existing.length} jams loaded, starting ~page ${startPage}\n`);
    } catch {
      console.log("No existing catalog found, starting fresh.\n");
    }
  }

  let totalPages = null;
  let emptyPages = 0;

  for (let page = startPage; ; page++) {
    if (maxPages && (page - startPage + 1) > maxPages) {
      console.log(`\nReached --pages limit (${maxPages}).`);
      break;
    }

    const url = page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
    process.stdout.write(`  Page ${page}${totalPages ? `/${totalPages}` : ""} ... `);

    let html;
    try {
      const res = await queuedFetch(url);
      if (!res.ok) {
        console.log(`HTTP ${res.status} — stopping.`);
        break;
      }
      html = await res.text();
    } catch (err) {
      console.log(`Error: ${err.message} — stopping.`);
      break;
    }

    if (!totalPages) {
      totalPages = parseTotalPages(html);
      if (totalPages) process.stdout.write(`(${totalPages} pages total) `);
    }

    const pageJams = parseJamListPage(html);

    if (pageJams.length === 0) {
      emptyPages++;
      console.log(`0 jams parsed (empty #${emptyPages}).`);
      if (emptyPages >= 3) {
        console.log("3 consecutive empty pages — stopping.");
        break;
      }
      continue;
    }
    emptyPages = 0;

    // Filter and collect
    let added = 0;
    const skipped = { dup: 0, subs: 0, ranked: 0 };

    for (const jam of pageJams) {
      if (existingSlugs.has(jam.slug))                { skipped.dup++; continue; }
      if (rankedOnly && !jam.ranked)                  { skipped.ranked++; continue; }
      if (minSubs > 0 && jam.submissions < minSubs)   { skipped.subs++; continue; }

      allJams.push(jam);
      existingSlugs.add(jam.slug);
      added++;
    }

    const lowestSubs = pageJams[pageJams.length - 1]?.submissions ?? 0;
    const skipParts = [];
    if (skipped.dup > 0)    skipParts.push(`${skipped.dup} dup`);
    if (skipped.subs > 0)   skipParts.push(`${skipped.subs} <min`);
    if (skipped.ranked > 0) skipParts.push(`${skipped.ranked} unranked`);

    console.log(
      `${pageJams.length} found, ${added} new` +
      (skipParts.length ? ` (${skipParts.join(", ")})` : "") +
      ` | lowest: ${lowestSubs} subs`
    );

    // Stop if everything on this page is below threshold
    if (minSubs > 0 && lowestSubs < minSubs && skipped.subs >= pageJams.length - skipped.dup) {
      console.log(`\nAll remaining jams below ${minSubs} submissions — stopping.`);
      break;
    }

    // Incremental save every 10 pages
    if (!dryRun && page % 10 === 0) {
      allJams.sort((a, b) => b.submissions - a.submissions);
      await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
      await fs.writeFile(OUTPUT_FILE, JSON.stringify(allJams, null, 2), "utf-8");
      console.log(`    💾 Checkpoint: ${allJams.length} jams saved`);
    }
  }

  // ── Final stats ──
  allJams.sort((a, b) => b.submissions - a.submissions);

  const rankedCount  = allJams.filter(j => j.ranked).length;
  const featuredCount = allJams.filter(j => j.featured).length;

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Total jams: ${allJams.length}`);
  console.log(`Ranked: ${rankedCount} | Featured: ${featuredCount}`);
  if (allJams.length > 0) {
    console.log(`Submissions: ${allJams[allJams.length - 1].submissions} – ${allJams[0].submissions}`);
  }

  // Distribution
  const buckets = [
    [5000, Infinity], [1000, 5000], [500, 1000],
    [100, 500], [50, 100], [20, 50], [0, 20],
  ];
  const labels = ["5000+", "1000-4999", "500-999", "100-499", "50-99", "20-49", "<20"];
  console.log("\nDistribution:");
  for (let i = 0; i < buckets.length; i++) {
    const [min, max] = buckets[i];
    const count = allJams.filter(j => j.submissions >= min && j.submissions < max).length;
    if (count > 0) console.log(`  ${labels[i].padEnd(12)} ${String(count).padStart(5)} jams`);
  }

  // ── Write ──
  if (!dryRun) {
    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(allJams, null, 2), "utf-8");
    const size = (await fs.stat(OUTPUT_FILE)).size;
    console.log(`\n✅ Written to ${OUTPUT_FILE} (${(size / 1024).toFixed(0)} KB)`);
  } else {
    console.log("\n[dry-run] No files written.");
    console.log("\nSample (first 15):");
    for (const j of allJams.slice(0, 15)) {
      console.log(`  ${String(j.submissions).padStart(6)} subs | ${j.ranked ? "R" : " "} | ${j.name}`);
    }
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });