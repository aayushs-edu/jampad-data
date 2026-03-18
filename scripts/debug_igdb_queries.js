/**
 * debug_igdb_queries.js
 *
 * Tests raw IGDB Apicalypse queries to isolate why findGames returns no results.
 * Starts with the broadest possible query and narrows down.
 */

"use strict";

const igdb = require("./igdb_client");

async function testQuery(label, endpoint, body) {
  console.log(`\n─ ${label} ─`);
  console.log(`  Query: ${body.replace(/\n/g, " | ")}`);
  try {
    const results = await igdb.igdbFetch(endpoint, body);
    console.log(`  Results: ${results.length}`);
    for (const g of results.slice(0, 3)) {
      console.log(`    ${g.name ?? g.id} ${g.rating ? `(rating: ${g.rating.toFixed(1)})` : ""}`);
    }
    return results;
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    return [];
  }
}

async function main() {
  await igdb.init();
  console.log("✓ Initialized\n");

  // 1. Absolute simplest query — just get any 5 games
  await testQuery(
    "Any 5 games (no filters)",
    "games",
    "fields name,rating;\nlimit 5;"
  );

  // 2. Main games only (category = 0)
  await testQuery(
    "Main games only",
    "games",
    "fields name,rating;\nwhere category = 0;\nlimit 5;"
  );

  // 3. Puzzle genre (id 9) — no rating filter
  await testQuery(
    "Puzzle genre, no rating filter",
    "games",
    "fields name,rating,genres.name;\nwhere category = 0 & genres = (9);\nsort rating desc;\nlimit 5;"
  );

  // 4. Puzzle genre + rating >= 70
  await testQuery(
    "Puzzle genre + rating >= 70",
    "games",
    "fields name,rating,genres.name;\nwhere category = 0 & genres = (9) & rating >= 70;\nsort rating desc;\nlimit 5;"
  );

  // 5. Horror theme (id 19) — no rating filter
  await testQuery(
    "Horror theme, no rating filter",
    "games",
    "fields name,rating,themes.name;\nwhere category = 0 & themes = (19);\nsort rating desc;\nlimit 5;"
  );

  // 6. Puzzle + Horror combined — no rating filter
  await testQuery(
    "Puzzle genre + Horror theme, NO rating filter",
    "games",
    "fields name,rating,genres.name,themes.name;\nwhere category = 0 & genres = (9) & themes = (19);\nsort rating desc;\nlimit 5;"
  );

  // 7. Platform genre (id 8) — no filters
  await testQuery(
    "Platform genre, no rating filter",
    "games",
    "fields name,rating,genres.name;\nwhere category = 0 & genres = (8);\nsort rating desc;\nlimit 5;"
  );

  // 8. Platform + Side view perspective (id 4)
  await testQuery(
    "Platform genre + Side view, no rating filter",
    "games",
    "fields name,rating,genres.name,player_perspectives.name;\nwhere category = 0 & genres = (8) & player_perspectives = (4);\nsort rating desc;\nlimit 5;"
  );

  // 9. Search endpoint test
  await testQuery(
    "Search: Celeste",
    "games",
    'search "Celeste";\nfields name,rating,cover.image_id;\nlimit 5;'
  );

  // 10. Search without any where clause
  await testQuery(
    "Search: Celeste (no where clause)",
    "games",
    'search "Celeste";\nfields name,rating;\nlimit 5;'
  );

  // 11. Test the erotic filter — maybe themes != (42) syntax is wrong
  await testQuery(
    "Puzzle genre, explicit erotic exclusion",
    "games",
    "fields name,rating;\nwhere category = 0 & genres = (9) & themes != (42);\nsort rating desc;\nlimit 5;"
  );

  // 12. Try without category filter entirely
  await testQuery(
    "Puzzle genre, NO category filter, NO erotic filter",
    "games",
    "fields name,rating;\nwhere genres = (9);\nsort rating desc;\nlimit 5;"
  );

  console.log("\n✅ Debug complete.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});