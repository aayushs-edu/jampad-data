/**
 * scrape_itch_tag_index.js
 *
 * Scrapes all category pages of https://itch.io/tags to build a complete
 * index of every curated itch.io tag/genre/style/platform/tool/event.
 *
 * Categories scraped:
 *   /tags           → tags     → browse: /games/tag-{slug}
 *   /tags/genres    → genres   → browse: /games/genre-{slug}
 *   /tags/styles    → styles   → browse: /games/tag-{slug}
 *   /tags/platforms → platforms → browse: /games/tag-{slug}
 *   /tags/tools     → tools    → browse: /games/tag-{slug}
 *   /tags/events    → events   → browse: /games/tag-{slug}
 *
 * Skipped: assets, game-mods, physical-games (not in /games/ browse space)
 *
 * Output: data/itch_tag_index.json
 * Format: { "tag-gravity": { name: "Gravity", category: "tags" },
 *           "genre-visual-novel": { name: "Visual Novel", category: "genres" }, ... }
 *
 * The key is the URL path segment used in browse URLs:
 *   https://itch.io/games/{key}
 *
 * Run periodically (monthly) to keep the index fresh.
 *
 * Usage:
 *   node scripts/scrape_itch_tag_index.js             # scrape all categories
 *   node scripts/scrape_itch_tag_index.js --dry-run   # print stats, don't write
 *   node scripts/scrape_itch_tag_index.js --verbose   # log each tag found
 */

"use strict";

const fs      = require("fs/promises");
const path    = require("path");
const https   = require("https");
const cheerio = require("cheerio");

// ─── Config ───────────────────────────────────────────────────────────────────

const OUTPUT_FILE = path.resolve(__dirname, "../data/itch_tag_index.json");

const REQUEST_DELAY    = 1100;  // ms between requests (safe under 1 req/sec)
const MAX_RETRIES      = 2;
const RETRY_BASE_DELAY = 8000;  // ms, doubles per retry
const USER_AGENT       = "Mozilla/5.0 (compatible; JamPad/1.0)";

// Categories to scrape, in order. Assets/game-mods/physical-games skipped —
// they use /game-assets/ and /game-mods/ browse paths, not /games/.
const CATEGORIES = [
  { url: "https://itch.io/tags",           name: "tags" },
  { url: "https://itch.io/tags/genres",    name: "genres" },
  { url: "https://itch.io/tags/styles",    name: "styles" },
  { url: "https://itch.io/tags/platforms", name: "platforms" },
  { url: "https://itch.io/tags/tools",     name: "tools" },
  { url: "https://itch.io/tags/events",    name: "events" },
];

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const dryRun  = args.includes("--dry-run");
const verbose = args.includes("--verbose");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPage(url, retries = 0) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      agent: new https.Agent({ keepAlive: true }),
    });

    if (res.status === 429 || res.status >= 500) {
      if (retries >= MAX_RETRIES) {
        throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries: ${url}`);
      }
      const delay = RETRY_BASE_DELAY * Math.pow(2, retries);
      console.warn(`  ⏳ ${res.status} — waiting ${delay / 1000}s (retry ${retries + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return fetchPage(url, retries + 1);
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.text();
  } finally {
    await sleep(REQUEST_DELAY);
  }
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a tags index page and extract all entries.
 *
 * Confirmed live HTML structure:
 *   <ul class="tag_list">
 *     <li class="tag_cell">
 *       <a class="header_image" href="/games/tag-no-ai"><!-- images --></a>
 *       <div>
 *         <a class="tag_title" href="/games/tag-no-ai">No AI</a>   ← what we target
 *       </div>
 *       ...
 *     </li>
 *   </ul>
 *
 * On the genres page, href is "/games/genre-visual-novel" instead of "/games/tag-*".
 * Both patterns match /^\/games\/([a-z][a-z0-9-]*)$/.
 *
 * Returns array of { key, name } where key = path segment (e.g. "tag-gravity").
 */
function parseTagsPage(html) {
  const $ = cheerio.load(html);
  const entries = [];
  const seen = new Set();

  $("a.tag_title").each((_, el) => {
    const href = $(el).attr("href") || "";

    // Match /games/{key} — the key is the full path segment after /games/
    // e.g. "tag-gravity", "genre-visual-novel"
    const match = href.match(/^\/games\/([a-z][a-z0-9-]*)$/);
    if (!match) return;

    const key  = match[1];
    const name = $(el).text().trim();
    if (!name || seen.has(key)) return;
    seen.add(key);

    entries.push({ key, name });

    if (verbose) {
      console.log(`    ${key.padEnd(35)} "${name}"`);
    }
  });

  return entries;
}

/**
 * Detect the total number of pages.
 * Actual HTML: <span class="pager_label">Page 1 of <a href="?page=16">16</a></span>
 */
function parseTotalPages(html) {
  const $ = cheerio.load(html);

  const label = $(".pager_label").text().trim();
  const m = label.match(/Page\s+\d+\s+of\s+([\d,]+)/);
  if (m) return parseInt(m[1].replace(/,/g, ""));

  // Fallback: highest ?page=N in any link
  let maxPage = 1;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const pm = href.match(/[?&]page=(\d+)/);
    if (pm) {
      const n = parseInt(pm[1]);
      if (n > maxPage) maxPage = n;
    }
  });
  return maxPage > 1 ? maxPage : null;
}

// ─── Scrape one category ──────────────────────────────────────────────────────

async function scrapeCategory(category, allEntries) {
  console.log(`\n[ ${category.name} ] ${category.url}`);

  let totalPages = null;
  let emptyPages = 0;
  let addedTotal = 0;

  for (let page = 1; ; page++) {
    const url = page === 1 ? category.url : `${category.url}?page=${page}`;
    process.stdout.write(`  Page ${page}${totalPages ? `/${totalPages}` : ""} ... `);

    let html;
    try {
      html = await fetchPage(url);
    } catch (err) {
      console.log(`Error: ${err.message} — stopping category.`);
      break;
    }

    if (page === 1) {
      totalPages = parseTotalPages(html);
      if (totalPages) process.stdout.write(`(${totalPages} pages) `);
      else process.stdout.write(`(1 page) `);
    }

    const pageEntries = parseTagsPage(html);

    if (pageEntries.length === 0) {
      emptyPages++;
      console.log(`0 found (empty #${emptyPages}).`);
      continue;
    }
    emptyPages = 0;

    let added = 0, recategorized = 0;
    for (const { key, name } of pageEntries) {
      if (!allEntries[key]) {
        allEntries[key] = { name, category: category.name };
        added++;
        addedTotal++;
      } else if (allEntries[key].category !== category.name) {
        // Key already seen in "tags" — update to the more specific category
        allEntries[key].category = category.name;
        recategorized++;
      }
    }

    const extra = recategorized ? `, ${recategorized} recategorized` : "";
    console.log(`${pageEntries.length} found, ${added} new${extra}`);

    // Stop if we've hit the last page, or if there was no pagination at all (1-page category)
    if (!totalPages || page >= totalPages) {
      break;
    }
  }

  return addedTotal;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Itch Tag Index Scraper");
  console.log("======================");
  if (dryRun) console.log("Mode: DRY RUN — no files will be written.");
  console.log(`Categories: ${CATEGORIES.map(c => c.name).join(", ")}`);

  const allEntries = {};  // key → { name, category }

  for (const category of CATEGORIES) {
    await scrapeCategory(category, allEntries);
  }

  // ── Summary ──
  const total = Object.keys(allEntries).length;
  const byCategory = {};
  for (const { category } of Object.values(allEntries)) {
    byCategory[category] = (byCategory[category] || 0) + 1;
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Total entries: ${total}`);
  for (const [cat, count] of Object.entries(byCategory)) {
    console.log(`  ${cat.padEnd(12)} ${count}`);
  }

  if (verbose) {
    console.log("\nSample (first 20):");
    Object.entries(allEntries).slice(0, 20).forEach(([key, { name, category }]) => {
      console.log(`  ${key.padEnd(35)} ${name}  [${category}]`);
    });
  }

  // ── Write ──
  if (!dryRun) {
    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(allEntries, null, 2), "utf-8");
    const stat = await fs.stat(OUTPUT_FILE);
    console.log(`\n✅ Written to ${OUTPUT_FILE} (${(stat.size / 1024).toFixed(0)} KB)`);
  } else {
    console.log("\n[dry-run] No files written.");
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
