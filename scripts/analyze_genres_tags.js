"use strict";

/**
 * analyze_genres_tags.js
 *
 * Reports coverage and frequency of Genre/Tags fields from scraped game details.
 *
 * Usage:
 *   node scripts/analyze_genres_tags.js                    # all jams
 *   node scripts/analyze_genres_tags.js --jam <n>          # one jam
 *   node scripts/analyze_genres_tags.js --from <n> --to <n> # jam range (inclusive)
 *   node scripts/analyze_genres_tags.js --top <n>          # show top N results (default 20)
 */

const fs   = require("fs/promises");
const path = require("path");

const JAM_DIR = path.join("data", "jam_data");

const args      = process.argv.slice(2);
const jamFilter = args.includes("--jam")  ? parseInt(args[args.indexOf("--jam")  + 1], 10) : null;
const fromJam   = args.includes("--from") ? parseInt(args[args.indexOf("--from") + 1], 10) : null;
const toJam     = args.includes("--to")   ? parseInt(args[args.indexOf("--to")   + 1], 10) : null;
const topN      = args.includes("--top")  ? parseInt(args[args.indexOf("--top")  + 1], 10) : 20;

function splitField(value) {
  return value.split(",").map(s => s.trim()).filter(Boolean);
}

function topEntries(counts, n) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function printBar(label, count, max, width = 30) {
  const filled = Math.round((count / max) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  console.log(`  ${label.padEnd(32)} ${bar} ${count}`);
}

async function main() {
  const allFiles = (await fs.readdir(JAM_DIR))
    .filter(f => f.endsWith(".json"))
    .sort((a, b) => parseInt(a) - parseInt(b));

  let selectedFiles;
  if (jamFilter !== null) {
    selectedFiles = allFiles.filter(f => parseInt(f) === jamFilter);
  } else if (fromJam !== null || toJam !== null) {
    const lo = fromJam ?? 1;
    const hi = toJam ?? Infinity;
    selectedFiles = allFiles.filter(f => { const n = parseInt(f); return n >= lo && n <= hi; });
  } else {
    selectedFiles = allFiles;
  }

  if (selectedFiles.length === 0) {
    console.error(jamFilter !== null ? `No jam found with n=${jamFilter}` : `No jams found in range ${fromJam}–${toJam}`);
    process.exit(1);
  }

  const filtered = await Promise.all(
    selectedFiles.map(f => fs.readFile(path.join(JAM_DIR, f), "utf-8").then(JSON.parse))
  );

  const games = filtered.flatMap(j => j.topGames ?? []);
  const total = games.length;

  let withDetails = 0, withGenre = 0, withTags = 0;
  const genreCounts = {};
  const tagCounts   = {};

  for (const game of games) {
    if (!game.details) continue;
    withDetails++;

    const { moreInfo = {} } = game.details;

    if (moreInfo.Genre) {
      withGenre++;
      for (const g of splitField(moreInfo.Genre)) {
        genreCounts[g] = (genreCounts[g] ?? 0) + 1;
      }
    }

    if (moreInfo.Tags) {
      withTags++;
      for (const t of splitField(moreInfo.Tags)) {
        tagCounts[t] = (tagCounts[t] ?? 0) + 1;
      }
    }
  }

  const label = jamFilter !== null
    ? `Jam #${jamFilter} — ${filtered[0].name}`
    : (fromJam !== null || toJam !== null)
      ? `Jams #${fromJam ?? 1}–#${toJam ?? filtered[filtered.length - 1].n} (${filtered.length} jams)`
      : `All ${filtered.length} jams`;

  console.log(`\nGenre & Tag Analysis — ${label}`);
  console.log("=".repeat(60));
  console.log(`  Total games:        ${total}`);
  console.log(`  With details:       ${withDetails} (${pct(withDetails, total)})`);
  console.log(`  With Genre field:   ${withGenre} (${pct(withGenre, total)})`);
  console.log(`  With Tags field:    ${withTags} (${pct(withTags, total)})`);

  const topGenres = topEntries(genreCounts, topN);
  const topTags   = topEntries(tagCounts,   topN);

  if (topGenres.length > 0) {
    console.log(`\nTop ${topN} Genres`);
    console.log("-".repeat(60));
    const maxG = topGenres[0][1];
    for (const [name, count] of topGenres) printBar(name, count, maxG);
  } else {
    console.log("\nNo Genre data found.");
  }

  if (topTags.length > 0) {
    console.log(`\nTop ${topN} Tags`);
    console.log("-".repeat(60));
    const maxT = topTags[0][1];
    for (const [name, count] of topTags) printBar(name, count, maxT);
  } else {
    console.log("\nNo Tags data found.");
  }

  console.log();
}

function pct(n, total) {
  return total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`;
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
