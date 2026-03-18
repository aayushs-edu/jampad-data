/**
 * build_itch_igdb_map.js
 *
 * Reads data/igdb_taxonomies.json and scans all itch jam data to produce
 * a mapping file: data/itch_to_igdb_map.json
 *
 * The mapping translates itch.io freeform Genre, Tags, and "Made with" strings
 * into structured IGDB taxonomy IDs (genres, themes, keywords, perspectives,
 * game_modes, game_engines).
 *
 * Strategy:
 *   1. Hand-curated overrides for known mismatches / itch-specific terms
 *   2. Exact slug/name matching against IGDB taxonomies
 *   3. Fuzzy fallback (normalized substring) for remaining terms
 *   4. Anything unresolved is logged so you can add manual overrides
 *
 * Usage:
 *   node scripts/build_itch_igdb_map.js
 *   node scripts/build_itch_igdb_map.js --verbose    # show match details
 *
 * Output:
 *   data/itch_to_igdb_map.json
 */

"use strict";

const fs   = require("fs/promises");
const path = require("path");

const TAXONOMY_FILE = path.resolve(__dirname, "../data/igdb_taxonomies.json");
const JAM_DIR       = path.resolve(__dirname, "../data/jam_data");
const OUTPUT_FILE   = path.resolve(__dirname, "../data/itch_to_igdb_map.json");

const args    = process.argv.slice(2);
const verbose = args.includes("--verbose");

// ─── Hand-curated overrides ───────────────────────────────────────────────────
// Format: "lowercase itch term" → { type: "genre"|"theme"|"keyword"|"perspective"|"game_mode"|"engine", igdb_name: "..." }
// These handle cases where itch uses different naming than IGDB, or where a
// single itch term should map to a specific IGDB category.

const MANUAL_OVERRIDES = {
  // ── Itch genres → IGDB genres ──
  "puzzle":              { type: "genre", igdb_name: "Puzzle" },
  "action":              { type: "genre", igdb_name: "Hack and slash/Beat 'em up" },  // itch "Action" is broad; IGDB splits it
  "platformer":          { type: "genre", igdb_name: "Platform" },
  "adventure":           { type: "genre", igdb_name: "Adventure" },
  "shooter":             { type: "genre", igdb_name: "Shooter" },
  "simulation":          { type: "genre", igdb_name: "Simulator" },
  "strategy":            { type: "genre", igdb_name: "Strategy" },
  "survival":            { type: "theme", igdb_name: "Survival" },
  "visual novel":        { type: "genre", igdb_name: "Visual Novel" },
  "interactive fiction": { type: "genre", igdb_name: "Adventure" },
  "role playing":        { type: "genre", igdb_name: "Role-playing (RPG)" },
  "rhythm":              { type: "genre", igdb_name: "Music" },
  "card game":           { type: "genre", igdb_name: "Card & Board Game" },
  "fighting":            { type: "genre", igdb_name: "Fighting" },
  "racing":              { type: "genre", igdb_name: "Racing" },
  "sports":              { type: "genre", igdb_name: "Sport" },
  "educational":         { type: "genre", igdb_name: "Quiz/Trivia" },

  // ── Itch tags → IGDB themes ──
  "horror":              { type: "theme", igdb_name: "Horror" },
  "psychological horror":{ type: "theme", igdb_name: "Horror" },
  "creepy":              { type: "theme", igdb_name: "Horror" },
  "dark":                { type: "theme", igdb_name: "Horror" },
  "comedy":              { type: "theme", igdb_name: "Comedy" },
  "funny":               { type: "theme", igdb_name: "Comedy" },
  "sci-fi":              { type: "theme", igdb_name: "Science fiction" },
  "space":               { type: "theme", igdb_name: "Science fiction" },
  "fantasy":             { type: "theme", igdb_name: "Fantasy" },
  "mystery":             { type: "theme", igdb_name: "Mystery" },
  "stealth":             { type: "theme", igdb_name: "Stealth" },
  "story rich":          { type: "theme", igdb_name: "Drama" },
  "narrative":           { type: "theme", igdb_name: "Drama" },
  "roguelike":           { type: "keyword", igdb_name: "roguelike" },
  "roguelite":           { type: "keyword", igdb_name: "roguelite" },
  "bullet hell":         { type: "keyword", igdb_name: "bullet-hell" },
  "boss battle":         { type: "keyword", igdb_name: "boss-fight" },
  "exploration":         { type: "theme", igdb_name: "Sandbox" },
  "relaxing":            { type: "keyword", igdb_name: "relaxing" },
  "physics":             { type: "keyword", igdb_name: "physics" },

  // ── Itch tags → IGDB player perspectives ──
  "2d":                  { type: "perspective", igdb_name: "Side view" },
  "3d":                  { type: "perspective", igdb_name: "Third person" },
  "first-person":        { type: "perspective", igdb_name: "First person" },
  "top-down":            { type: "perspective", igdb_name: "Bird view/Isometric" },
  "top down shooter":    { type: "perspective", igdb_name: "Bird view/Isometric" },
  "isometric":           { type: "perspective", igdb_name: "Bird view/Isometric" },
  "point & click":       { type: "genre", igdb_name: "Point-and-click" },

  // ── Itch tags → IGDB game modes ──
  "singleplayer":        { type: "game_mode", igdb_name: "Single player" },
  "multiplayer":         { type: "game_mode", igdb_name: "Multiplayer" },
  "co-op":               { type: "game_mode", igdb_name: "Co-operative" },
  "local multiplayer":   { type: "game_mode", igdb_name: "Split screen" },

  // ── Itch "Made with" / tags → IGDB engines ──
  "unity":               { type: "engine", igdb_name: "Unity" },
  "godot":               { type: "engine", igdb_name: "Godot Engine" },
  "unreal engine":       { type: "engine", igdb_name: "Unreal Engine" },
  "gamemaker":           { type: "engine", igdb_name: "GameMaker" },
  "gamemaker studio 2":  { type: "engine", igdb_name: "GameMaker: Studio" },
  "construct":           { type: "engine", igdb_name: "Construct" },
  "construct 3":         { type: "engine", igdb_name: "Construct 3" },
  "rpg maker":           { type: "engine", igdb_name: "RPG Maker" },
  "ren'py":              { type: "engine", igdb_name: "Ren'Py" },
  "renpy":               { type: "engine", igdb_name: "Ren'Py" },
  "pico-8":              { type: "engine", igdb_name: "PICO-8" },
  "twine":               { type: "engine", igdb_name: "Twine" },
  "love2d":              { type: "engine", igdb_name: "LÖVE" },
  "pygame":              { type: "engine", igdb_name: "Pygame" },
  "gb studio":           { type: "engine", igdb_name: "GB Studio" },
  "bitsy":               { type: "engine", igdb_name: "Bitsy" },
  "gdevelop":            { type: "engine", igdb_name: "GDevelop" },
  "monogame":            { type: "engine", igdb_name: "MonoGame" },
  "phaser":              { type: "engine", igdb_name: "Phaser" },

  // ── Tags to skip (not useful for IGDB mapping) ──
  "short":               null,
  "pixel art":           null,  // art style, not a mechanic/theme
  "retro":               null,
  "atmospheric":         null,
  "cute":                null,
  "indie":               null,
  "casual":              null,
  "no ai":               null,
  "puzzle-platformer":   null,  // compound — handled via separate genre matches
  "game maker's toolkit jam": null,
  "my first game jam":   null,
  "game jam":            null,
  "minimalist":          null,
  "fast-paced":          null,
  "low-poly":            null,
  "hand-drawn":          null,
  "1-bit":               null,
  "difficult":           null,
  "high score":          null,
  "arcade":              null,  // itch uses as tag; closest IGDB is "Arcade" genre but weak match
  "music":               null,  // ambiguous — could be genre or tag
  "colorful":            null,
  "abstract":            null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(str) {
  return str.toLowerCase().trim().replace(/['']/g, "'").replace(/\s+/g, " ");
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Try to find a match in an IGDB taxonomy list by name or slug.
 */
function findInTaxonomy(term, items) {
  const normTerm = normalize(term);
  const slugTerm = slugify(term);

  // Exact name match (case-insensitive)
  let match = items.find(i => normalize(i.name) === normTerm);
  if (match) return match;

  // Exact slug match
  match = items.find(i => i.slug === slugTerm);
  if (match) return match;

  // Substring: IGDB name contains itch term or vice versa
  match = items.find(i => {
    const normName = normalize(i.name);
    return normName.includes(normTerm) || normTerm.includes(normName);
  });
  if (match) return match;

  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Build Itch → IGDB Mapping");
  console.log("=========================\n");

  // 1. Load IGDB taxonomies
  const taxonomies = JSON.parse(await fs.readFile(TAXONOMY_FILE, "utf-8"));
  console.log("Loaded IGDB taxonomies:");
  for (const key of ["genres", "themes", "keywords", "player_perspectives", "game_modes", "game_engines"]) {
    console.log(`  ${key}: ${taxonomies[key].length} items`);
  }

  // 2. Collect all unique itch terms
  const allFiles = (await fs.readdir(JAM_DIR))
    .filter(f => f.endsWith(".json"))
    .sort((a, b) => parseInt(a) - parseInt(b));

  const genreCounts  = {};
  const tagCounts    = {};
  const engineCounts = {};

  for (const file of allFiles) {
    const jam = JSON.parse(await fs.readFile(path.join(JAM_DIR, file), "utf-8"));
    for (const game of (jam.topGames ?? [])) {
      if (!game.details?.moreInfo) continue;
      const { Genre, Tags, "Made with": madeWith } = game.details.moreInfo;

      if (Genre) {
        for (const g of Genre.split(",").map(s => s.trim()).filter(Boolean)) {
          genreCounts[g] = (genreCounts[g] ?? 0) + 1;
        }
      }
      if (Tags) {
        for (const t of Tags.split(",").map(s => s.trim()).filter(Boolean)) {
          tagCounts[t] = (tagCounts[t] ?? 0) + 1;
        }
      }
      if (madeWith) {
        const engine = madeWith.trim();
        if (engine) engineCounts[engine] = (engineCounts[engine] ?? 0) + 1;
      }
    }
  }

  console.log(`\nUnique itch terms: ${Object.keys(genreCounts).length} genres, ${Object.keys(tagCounts).length} tags, ${Object.keys(engineCounts).length} engines\n`);

  // 3. Build mapping
  const mapping = {
    _meta: {
      built_at: new Date().toISOString(),
      description: "Maps itch.io freeform terms to IGDB taxonomy IDs. null = intentionally skipped.",
    },
    genres: {},   // itch genre string → { igdb_type, igdb_id, igdb_name } | null
    tags: {},     // itch tag string   → { igdb_type, igdb_id, igdb_name } | null
    engines: {},  // itch "Made with"  → { igdb_id, igdb_name } | null
  };

  const unresolved = { genres: [], tags: [], engines: [] };

  // Helper: resolve a single itch term
  function resolve(term, source) {
    const key = normalize(term);

    // Check manual overrides first
    if (key in MANUAL_OVERRIDES) {
      const override = MANUAL_OVERRIDES[key];
      if (override === null) return null; // intentionally skipped

      // Look up the IGDB ID
      const taxonomyKey = {
        genre: "genres",
        theme: "themes",
        keyword: "keywords",
        perspective: "player_perspectives",
        game_mode: "game_modes",
        engine: "game_engines",
      }[override.type];

      const items = taxonomies[taxonomyKey] ?? [];
      const match = items.find(i =>
        normalize(i.name) === normalize(override.igdb_name) ||
        i.slug === slugify(override.igdb_name)
      );

      if (match) {
        return { igdb_type: override.type, igdb_id: match.id, igdb_name: match.name };
      } else {
        if (verbose) console.warn(`  ⚠ Override "${term}" → "${override.igdb_name}" not found in IGDB ${taxonomyKey}`);
        return { igdb_type: override.type, igdb_id: null, igdb_name: override.igdb_name };
      }
    }

    // Auto-match: try each taxonomy in priority order
    const searchOrder = source === "engine"
      ? [["game_engines", "engine"]]
      : [
          ["genres", "genre"],
          ["themes", "theme"],
          ["player_perspectives", "perspective"],
          ["game_modes", "game_mode"],
          ["keywords", "keyword"],
        ];

    for (const [taxKey, typeName] of searchOrder) {
      const match = findInTaxonomy(term, taxonomies[taxKey]);
      if (match) {
        return { igdb_type: typeName, igdb_id: match.id, igdb_name: match.name };
      }
    }

    return undefined; // truly unresolved
  }

  // Process genres (sorted by frequency)
  const sortedGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]);
  for (const [genre, count] of sortedGenres) {
    const result = resolve(genre, "genre");
    if (result === undefined) {
      unresolved.genres.push({ term: genre, count });
      mapping.genres[genre] = null;
    } else {
      mapping.genres[genre] = result;
    }
  }

  // Process tags (only those appearing 5+ times to avoid noise)
  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  for (const [tag, count] of sortedTags) {
    if (count < 5) continue; // skip very rare tags
    const result = resolve(tag, "tag");
    if (result === undefined) {
      unresolved.tags.push({ term: tag, count });
      mapping.tags[tag] = null;
    } else {
      mapping.tags[tag] = result;
    }
  }

  // Process engines
  const sortedEngines = Object.entries(engineCounts).sort((a, b) => b[1] - a[1]);
  for (const [engine, count] of sortedEngines) {
    const result = resolve(engine, "engine");
    if (result === undefined) {
      unresolved.engines.push({ term: engine, count });
      mapping.engines[engine] = null;
    } else {
      mapping.engines[engine] = result;
    }
  }

  // 4. Report
  const resolvedGenres  = Object.values(mapping.genres).filter(v => v !== null).length;
  const resolvedTags    = Object.values(mapping.tags).filter(v => v !== null).length;
  const resolvedEngines = Object.values(mapping.engines).filter(v => v !== null).length;

  console.log("─".repeat(50));
  console.log("Mapping results:");
  console.log(`  Genres:  ${resolvedGenres}/${sortedGenres.length} mapped, ${unresolved.genres.length} unresolved`);
  console.log(`  Tags:    ${resolvedTags}/${sortedTags.filter(([,c]) => c >= 5).length} mapped (≥5 occurrences), ${unresolved.tags.length} unresolved`);
  console.log(`  Engines: ${resolvedEngines}/${sortedEngines.length} mapped, ${unresolved.engines.length} unresolved`);

  if (unresolved.genres.length > 0) {
    console.log("\n  Unresolved genres:");
    for (const { term, count } of unresolved.genres) {
      console.log(`    "${term}" (×${count})`);
    }
  }
  if (unresolved.tags.length > 0) {
    console.log("\n  Unresolved tags (top 20):");
    for (const { term, count } of unresolved.tags.slice(0, 20)) {
      console.log(`    "${term}" (×${count})`);
    }
    if (unresolved.tags.length > 20) {
      console.log(`    ... and ${unresolved.tags.length - 20} more`);
    }
  }
  if (unresolved.engines.length > 0) {
    console.log("\n  Unresolved engines:");
    for (const { term, count } of unresolved.engines) {
      console.log(`    "${term}" (×${count})`);
    }
  }

  // 5. Write
  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(mapping, null, 2), "utf-8");
  console.log(`\n✅ Written to ${OUTPUT_FILE}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });