/**
 * test_itch_tag_search.js
 *
 * Manual tester for the itch tag search pipeline.
 *
 * Usage:
 *   node scripts/test_itch_tag_search.js gravity
 *   node scripts/test_itch_tag_search.js "time travel"
 *   node scripts/test_itch_tag_search.js "everything is connected" --llm
 *   node scripts/test_itch_tag_search.js "everything is connected" --compare
 *   node scripts/test_itch_tag_search.js "everything is connected" --compare --model gemma3:12b
 *   node scripts/test_itch_tag_search.js gravity --no-cache
 *   node scripts/test_itch_tag_search.js --cache-stats
 */

"use strict";

const itchSearch = require("./itch_tag_search");

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const theme      = args.find(a => !a.startsWith("--"));
const useLLM     = args.includes("--llm");
const noCache    = args.includes("--no-cache");
const tagsOnly   = args.includes("--tags-only");
const cacheStats = args.includes("--cache-stats");
const compare    = args.includes("--compare");

const modelIdx   = args.indexOf("--model");
const ollamaModel = modelIdx !== -1 ? args[modelIdx + 1] : "llama3.2:3b";

// ─── Ollama LLM call (mirrors extract_jam_themes.js pattern) ─────────────────

async function callOllamaForTags(theme, tagIndex) {
  const vocab = Object.entries(tagIndex)
    .map(([key, { name }]) => `${key} (${name})`)
    .slice(0, 500)
    .join(", ");

  const prompt =
    `You are a game tag expert for itch.io. Given a game jam theme, identify relevant itch.io tags and genres from the vocabulary below.\n\n` +
    `Theme: "${theme}"\n\n` +
    `Available keys (key (Display Name)):\n${vocab}\n\n` +
    `Return ONLY a JSON object: {"candidate_slugs": ["tag-example", "genre-example", ...], "reasoning": "one sentence"}\n` +
    `Only include keys that appear verbatim in the vocabulary. 5-10 keys.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body: JSON.stringify({
        model:   ollamaModel,
        prompt,
        stream:  false,
        options: { temperature: 0.3, num_predict: 200 },
      }),
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);

    const data = await res.json();
    const text = data.response || "";

    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error(`No JSON in response: ${text.slice(0, 100)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.candidate_slugs || [];
  } catch (err) {
    const msg = err.name === "AbortError" ? "timeout (60s)" : err.message;
    throw new Error(`Ollama failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Compare mode ─────────────────────────────────────────────────────────────

async function runComparison(theme, tagIndex) {
  console.log(`\n[ LLM Comparison — "${theme}" ]\n`);
  console.log(`Ollama model: ${ollamaModel}`);
  console.log("─".repeat(50));

  // Run both in parallel
  const [geminiResult, ollamaResult] = await Promise.allSettled([
    itchSearch.matchOnly(theme, { useLLM: true }),
    callOllamaForTags(theme, tagIndex),
  ]);

  // Gemini results (full matcher output includes exact+fuzzy+llm)
  console.log("\n[ Gemini (gemini-2.5-flash-lite) ]");
  if (geminiResult.status === "rejected") {
    console.log(`  Error: ${geminiResult.reason.message}`);
  } else {
    for (const t of geminiResult.value) {
      console.log(`  ${t.slug.padEnd(35)} "${t.name}"  score=${t.score.toFixed(2)}  via=${t.strategy}`);
    }
  }

  // Ollama results — validate candidates against the index
  console.log(`\n[ Ollama (${ollamaModel}) ]`);
  if (ollamaResult.status === "rejected") {
    console.log(`  Error: ${ollamaResult.reason.message}`);
  } else {
    const candidates = ollamaResult.value;
    if (candidates.length === 0) {
      console.log("  No valid candidates returned.");
    } else {
      for (const key of candidates) {
        const entry = tagIndex[key];
        const valid = entry ? `"${entry.name}"` : "(NOT IN INDEX)";
        console.log(`  ${key.padEnd(35)} ${valid}`);
      }
    }
  }

  // Overlap
  if (geminiResult.status === "fulfilled" && ollamaResult.status === "fulfilled") {
    const geminiSlugs = new Set(geminiResult.value.map(t => t.slug));
    const ollamaSlugs = new Set(ollamaResult.value.filter(k => tagIndex[k]));
    const overlap = [...geminiSlugs].filter(s => ollamaSlugs.has(s));
    const onlyGemini = [...geminiSlugs].filter(s => !ollamaSlugs.has(s));
    const onlyOllama = [...ollamaSlugs].filter(s => !geminiSlugs.has(s));

    console.log("\n[ Agreement ]");
    if (overlap.length)    console.log(`  Both:         ${overlap.join(", ")}`);
    if (onlyGemini.length) console.log(`  Gemini only:  ${onlyGemini.join(", ")}`);
    if (onlyOllama.length) console.log(`  Ollama only:  ${onlyOllama.join(", ")}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (cacheStats) {
    const stats = await itchSearch.cache.stats();
    console.log("Cache stats:", stats);
    return;
  }

  if (!theme) {
    console.error("Usage: node scripts/test_itch_tag_search.js <theme> [--llm] [--compare] [--model <name>] [--no-cache] [--tags-only]");
    console.error("       node scripts/test_itch_tag_search.js --cache-stats");
    process.exit(1);
  }

  console.log("Loading tag index...");
  await itchSearch.init();

  if (compare) {
    const tagIndex = itchSearch.matcher.getIndex();
    await runComparison(theme, tagIndex);
    return;
  }

  console.log(`\nTheme: "${theme}"`);
  console.log(`LLM: ${useLLM ? "enabled" : "disabled (pass --llm to enable)"}`);
  console.log("─".repeat(50));

  // Step 1: matched tags
  console.log("\n[ Tag Matches ]");
  const tags = await itchSearch.matchOnly(theme, { useLLM });
  if (tags.length === 0) {
    console.log("  No tags matched.");
    return;
  }
  for (const t of tags) {
    console.log(`  ${t.slug.padEnd(35)} "${t.name}"  score=${t.score.toFixed(2)}  via=${t.strategy}`);
  }

  if (tagsOnly) return;

  // Step 2: fetch games
  console.log("\n[ Fetching Games ]");
  const { games } = await itchSearch.findGames(theme, {
    useLLM,
    noCache,
    limitPerTag: 15,
    limitTotal:  30,
  });

  if (games.length === 0) {
    console.log("  No games found.");
    return;
  }

  console.log(`\n[ Results — ${games.length} games ]\n`);
  for (const g of games) {
    const browser = g.browserPlayable ? " [browser]" : "";
    const multi   = g._tags.length > 1 ? ` (tags: ${g._tags.join("+")})` : "";
    console.log(`  ${g.title}${browser}`);
    console.log(`    ${g.url}`);
    if (g.genre)       console.log(`    Genre: ${g.genre}${multi}`);
    if (g.author)      console.log(`    By: ${g.author}`);
    if (g.description) console.log(`    "${g.description.slice(0, 100)}"`);
    console.log();
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
