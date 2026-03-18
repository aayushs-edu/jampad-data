/**
 * cache_igdb_taxonomies.js
 *
 * Pulls the full IGDB taxonomy data (themes, genres, keywords, player perspectives,
 * game modes) and writes it to data/igdb_taxonomies.json.
 *
 * These are small, finite lists that rarely change — caching them locally avoids
 * burning live API calls on static lookups.
 *
 * Setup:
 *   1. Create a Twitch Developer app at https://dev.twitch.tv/
 *   2. Add TWITCH_CLIENTID and TWITCH_CLIENTSECRET to .env in the project root
 *   3. npm install dotenv (if not already installed)
 *
 * Usage:
 *   node scripts/cache_igdb_taxonomies.js
 *   node scripts/cache_igdb_taxonomies.js --dry-run   # print counts, don't write
 *
 * Output:
 *   data/igdb_taxonomies.json
 */

"use strict";

const fs   = require("fs/promises");
const path = require("path");

// ─── Load .env ────────────────────────────────────────────────────────────────

try {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
} catch {
  // dotenv not installed — fall back to process.env
}

const CLIENT_ID     = process.env.TWITCH_CLIENTID;
const CLIENT_SECRET = process.env.TWITCH_CLIENTSECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing TWITCH_CLIENTID or TWITCH_CLIENTSECRET in .env");
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const IGDB_BASE     = "https://api.igdb.com/v4";
const AUTH_URL      = "https://id.twitch.tv/oauth2/token";
const OUTPUT_FILE   = path.resolve(__dirname, "../data/igdb_taxonomies.json");
const REQUEST_DELAY = 300; // ms between requests (stay well under 4/sec limit)

const args   = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAccessToken() {
  const url = `${AUTH_URL}?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Auth failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.access_token;
}

// ─── IGDB query helper ────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Query an IGDB endpoint with the Apicalypse body syntax.
 * Automatically paginates if the endpoint has more than `limit` results.
 */
async function igdbQuery(token, endpoint, fields, { limit = 500, where = "" } = {}) {
  const allResults = [];
  let offset = 0;

  while (true) {
    const body = [
      `fields ${fields};`,
      `limit ${limit};`,
      `offset ${offset};`,
      where ? `where ${where};` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const res = await fetch(`${IGDB_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": CLIENT_ID,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body,
    });

    if (res.status === 429) {
      console.warn("  ⏳ Rate limited — waiting 2s...");
      await sleep(2000);
      continue; // retry same offset
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`IGDB ${endpoint} failed (${res.status}): ${errBody}`);
    }

    const data = await res.json();
    allResults.push(...data);

    // If we got fewer than `limit` results, we've fetched everything
    if (data.length < limit) break;

    offset += limit;
    await sleep(REQUEST_DELAY);
  }

  return allResults;
}

// ─── Endpoints to cache ───────────────────────────────────────────────────────

const ENDPOINTS = [
  {
    key: "themes",
    endpoint: "themes",
    fields: "name,slug",
    description: "Game themes (e.g. Survival, Comedy, Horror)",
  },
  {
    key: "genres",
    endpoint: "genres",
    fields: "name,slug",
    description: "Game genres (e.g. Platformer, Puzzle, RPG)",
  },
  {
    key: "keywords",
    endpoint: "keywords",
    fields: "name,slug",
    description: "Game keywords/mechanics (e.g. time-manipulation, permadeath)",
  },
  {
    key: "player_perspectives",
    endpoint: "player_perspectives",
    fields: "name,slug",
    description: "Camera/view perspectives (e.g. Bird view, Side view)",
  },
  {
    key: "game_modes",
    endpoint: "game_modes",
    fields: "name,slug",
    description: "Game modes (e.g. Single player, Co-operative)",
  },
  {
    key: "game_engines",
    endpoint: "game_engines",
    fields: "name,slug",
    description: "Game engines (e.g. Unity, Unreal Engine, Godot)",
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("IGDB Taxonomy Cache");
  console.log("====================");
  if (dryRun) console.log("DRY RUN — will not write output.\n");

  // 1. Authenticate
  console.log("Authenticating with Twitch...");
  const token = await getAccessToken();
  console.log("  ✓ Got access token\n");

  // 2. Fetch each taxonomy
  const taxonomies = {
    _meta: {
      cached_at: new Date().toISOString(),
      description: "IGDB taxonomy data for JamPad. Regenerate with: node scripts/cache_igdb_taxonomies.js",
    },
  };

  for (const ep of ENDPOINTS) {
    console.log(`Fetching ${ep.key} (${ep.description})...`);
    const results = await igdbQuery(token, ep.endpoint, ep.fields);

    // Sort by ID for stable output
    results.sort((a, b) => a.id - b.id);

    taxonomies[ep.key] = results;
    console.log(`  ✓ ${results.length} items\n`);

    await sleep(REQUEST_DELAY);
  }

  // 3. Summary
  console.log("─".repeat(50));
  console.log("Summary:");
  for (const ep of ENDPOINTS) {
    const count = taxonomies[ep.key].length;
    console.log(`  ${ep.key.padEnd(22)} ${count}`);
  }

  // 4. Write output
  if (!dryRun) {
    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(taxonomies, null, 2), "utf-8");
    console.log(`\n✅ Written to ${OUTPUT_FILE}`);
  } else {
    // Show a sample of each
    console.log("\n[dry-run] Samples:");
    for (const ep of ENDPOINTS) {
      const sample = taxonomies[ep.key].slice(0, 5).map((x) => x.name);
      console.log(`  ${ep.key}: ${sample.join(", ")}${taxonomies[ep.key].length > 5 ? ", ..." : ""}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});