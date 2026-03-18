/**
 * test_igdb_client.js
 *
 * Smoke test for the IGDB client module. Runs a few representative queries
 * and prints the results so you can verify everything is wired up correctly.
 *
 * Usage:
 *   node scripts/test_igdb_client.js
 */

"use strict";

const igdb = require("./igdb_client");

async function main() {
  console.log("IGDB Client Test");
  console.log("=================\n");

  // 1. Initialize
  console.log("Initializing...");
  await igdb.init();
  console.log("  ✓ Authenticated and loaded taxonomies + mapping\n");

  // 2. Test: resolve some itch terms
  console.log("─ Term resolution ─");
  const tests = [
    ["Puzzle",      "genre"],
    ["Platformer",  "genre"],
    ["Horror",      "tag"],
    ["2D",          "tag"],
    ["Singleplayer","tag"],
    ["Unity",       "engine"],
    ["Godot",       "engine"],
  ];
  for (const [term, source] of tests) {
    const result = igdb.resolveItchTerm(term, source);
    if (result) {
      console.log(`  ${term} (${source}) → ${result.igdb_type} "${result.igdb_name}" [id: ${result.igdb_id}]`);
    } else {
      console.log(`  ${term} (${source}) → null (skipped or unmapped)`);
    }
  }

  // 3. Test: findGames with genre + theme
  console.log("\n─ findGames: Puzzle + Horror ─");
  const puzzleHorror = await igdb.findGames({
    genres: ["Puzzle"],
    themes: ["Horror"],
    minRating: 70,
    limit: 3,
  });
  for (const g of puzzleHorror) {
    console.log(`  ${g.name} (rating: ${g.rating?.toFixed(1) ?? "n/a"})`);
    console.log(`    cover: ${g._images.cover ?? "none"}`);
    console.log(`    genres: ${(g.genres ?? []).map(x => x.name).join(", ")}`);
  }
  if (puzzleHorror.length === 0) console.log("  (no results — try lowering minRating)");

  // 4. Test: findGames with perspective
  console.log("\n─ findGames: Platformer + 2D ─");
  const platformer2D = await igdb.findGames({
    genres: ["Platformer"],
    perspectives: ["2D"],
    minRating: 80,
    limit: 3,
  });
  for (const g of platformer2D) {
    console.log(`  ${g.name} (rating: ${g.rating?.toFixed(1) ?? "n/a"})`);
    console.log(`    cover: ${g._images.cover ?? "none"}`);
  }
  if (platformer2D.length === 0) console.log("  (no results)");

  // 5. Test: searchGame by name
  console.log("\n─ searchGame: 'Western' ─");
  const nameResults = await igdb.searchGame("Western", 3);
  for (const g of nameResults) {
    console.log(`  ${g.name} (rating: ${g.rating?.toFixed(1) ?? "n/a"})`);
    console.log(`    cover: ${g._images.cover ?? "none"}`);
    console.log(`    screenshots: ${g._images.screenshots.length}`);
  }

  // 6. Test: image URL construction
  console.log("\n─ Image URL examples ─");
  console.log(`  cover_big:       ${igdb.imageUrl("co1rba", "cover_big")}`);
  console.log(`  screenshot_huge: ${igdb.imageUrl("sc6k4f", "screenshot_huge")}`);
  console.log(`  cover_big_2x:    ${igdb.imageUrl("co1rba", "cover_big_2x")}`);

  console.log("\n✅ All tests complete.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});