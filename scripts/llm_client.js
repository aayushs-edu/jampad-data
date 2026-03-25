/**
 * llm_client.js
 *
 * Provider-agnostic LLM client for JamPad's Inspiration Engine.
 * Currently implements Gemini (Google AI Studio free tier).
 *
 * Features:
 *   - Structured JSON output via Gemini's responseSchema
 *   - Token-bucket rate limiter (respects free tier RPM/RPD)
 *   - Exponential backoff retry with 429/5xx handling
 *   - Two quality tiers: "fast" (Flash-Lite) and "smart" (Flash)
 *   - Provider swap via .env — engine code never touches HTTP
 *
 * Usage:
 *   const llm = require("./llm_client");
 *
 *   const result = await llm.complete({
 *     system: "You are a theme interpreter...",
 *     user:   "Theme: Connected\nVocabulary: ...",
 *     schema: { type: "object", properties: { ... } },
 *     quality: "fast",        // "fast" or "smart"
 *     temperature: 0.4,       // optional, default 0.3
 *   });
 *   // result is a parsed JS object matching the schema
 *
 * Environment:
 *   GEMINI_API_KEY         — required (get from https://aistudio.google.com/apikey)
 *   LLM_MODEL_FAST         — optional override (default: gemini-2.0-flash-lite)
 *   LLM_MODEL_SMART        — optional override (default: gemini-2.0-flash)
 *   LLM_LOG                — set to "1" to log prompts and responses to stderr
 */

"use strict";

const path = require("path");

// ─── Load .env ────────────────────────────────────────────────────────────────

try {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
} catch {
  // dotenv not installed — fall back to process.env
}

// ─── Config ───────────────────────────────────────────────────────────────────

const API_KEY     = process.env.GEMINI_API_KEY;
const MODEL_FAST  = process.env.LLM_MODEL_FAST  || "gemini-2.5-flash-lite";
const MODEL_SMART = process.env.LLM_MODEL_SMART || "gemini-2.5-flash";
const BASE_URL    = "https://generativelanguage.googleapis.com/v1beta/models";
const LOG         = process.env.LLM_LOG === "1";

// Rate limits (free tier, conservative)
const RATE_LIMITS = {
  fast:  { rpm: 14, rpd: 950  },  // Flash-Lite: 15 RPM, 1000 RPD
  smart: { rpm: 9,  rpd: 240  },  // Flash: 10 RPM, 250 RPD
};

// Retry config
const MAX_RETRIES   = 3;
const BASE_DELAY_MS = 1000;  // 1s → 2s → 4s

// ─── Rate limiter (token bucket per quality tier) ─────────────────────────────

class RateLimiter {
  constructor(rpm, rpd) {
    this.rpm = rpm;
    this.rpd = rpd;
    this.minuteTokens = rpm;
    this.dayTokens = rpd;
    this.lastMinuteRefill = Date.now();
    this.lastDayRefill = Date.now();
  }

  _refill() {
    const now = Date.now();

    // Refill minute tokens
    const minuteElapsed = now - this.lastMinuteRefill;
    if (minuteElapsed >= 60_000) {
      this.minuteTokens = this.rpm;
      this.lastMinuteRefill = now;
    } else {
      // Gradual refill: add tokens proportionally
      const tokensToAdd = (minuteElapsed / 60_000) * this.rpm;
      this.minuteTokens = Math.min(this.rpm, this.minuteTokens + tokensToAdd);
      this.lastMinuteRefill = now;
    }

    // Refill day tokens (reset at midnight-ish, or after 24h)
    if (now - this.lastDayRefill >= 86_400_000) {
      this.dayTokens = this.rpd;
      this.lastDayRefill = now;
    }
  }

  /**
   * Wait until a token is available, then consume it.
   * Returns the wait time in ms (0 if no wait needed).
   */
  async acquire() {
    this._refill();

    if (this.dayTokens <= 0) {
      throw new Error(
        "LLM daily rate limit exhausted. Resets at midnight Pacific. " +
        "Falling back to offline mode."
      );
    }

    if (this.minuteTokens >= 1) {
      this.minuteTokens -= 1;
      this.dayTokens -= 1;
      return 0;
    }

    // Wait for next token
    const waitMs = Math.ceil(
      ((1 - this.minuteTokens) / this.rpm) * 60_000
    );
    if (LOG) console.error(`[llm] Rate limited, waiting ${waitMs}ms`);
    await sleep(waitMs);
    this._refill();
    this.minuteTokens -= 1;
    this.dayTokens -= 1;
    return waitMs;
  }

  /** Current remaining capacity (for diagnostics) */
  status() {
    this._refill();
    return {
      minuteRemaining: Math.floor(this.minuteTokens),
      dayRemaining:    Math.floor(this.dayTokens),
    };
  }
}

const limiters = {
  fast:  new RateLimiter(RATE_LIMITS.fast.rpm,  RATE_LIMITS.fast.rpd),
  smart: new RateLimiter(RATE_LIMITS.smart.rpm, RATE_LIMITS.smart.rpd),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function modelForQuality(quality) {
  return quality === "smart" ? MODEL_SMART : MODEL_FAST;
}

// ─── Core: Gemini generateContent ─────────────────────────────────────────────

/**
 * Build the request body for Gemini's generateContent endpoint.
 */
function buildRequestBody({ system, user, schema, temperature = 0.3, maxTokens = 8192 }) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: user }],
      },
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  // System instruction
  if (system) {
    body.system_instruction = {
      parts: [{ text: system }],
    };
  }

  // Structured JSON output
  if (schema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = schema;
  }

  return body;
}

/**
 * Send a request to Gemini's generateContent endpoint.
 * Returns the raw response object.
 */
async function callGemini(model, body) {
  const url = `${BASE_URL}/${model}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    const err = new Error(
      `Gemini API error ${res.status}: ${errBody.slice(0, 300)}`
    );
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  return res.json();
}

/**
 * Extract the text content from a Gemini response.
 */
function extractText(response) {
  const candidates = response.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error("Gemini returned no candidates");
  }

  const parts = candidates[0].content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error("Gemini candidate has no parts");
  }

  return parts.map(p => p.text || "").join("");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a prompt to the LLM and get a structured response.
 *
 * @param {Object} opts
 * @param {string} opts.system       - System instruction
 * @param {string} opts.user         - User message (the main prompt)
 * @param {Object} [opts.schema]     - JSON Schema for structured output
 * @param {string} [opts.quality]    - "fast" (default) or "smart"
 * @param {number} [opts.temperature] - 0.0–2.0, default 0.3
 *
 * @returns {Object|string} Parsed JSON object if schema provided, raw text otherwise
 */
async function complete(opts) {
  const {
    system,
    user,
    schema,
    quality = "fast",
    temperature = 0.3,
    maxTokens = 8192,
  } = opts;

  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY not set. Get one at https://aistudio.google.com/apikey " +
      "and add it to your .env file."
    );
  }

  const model   = modelForQuality(quality);
  const limiter = limiters[quality] || limiters.fast;
  const body    = buildRequestBody({ system, user, schema, temperature, maxTokens });

  if (LOG) {
    console.error(`\n[llm] ── ${quality}/${model} ──`);
    console.error(`[llm] system: ${(system || "").slice(0, 100)}...`);
    console.error(`[llm] user: ${user.slice(0, 200)}...`);
    console.error(`[llm] schema: ${schema ? "yes" : "no"}`);
  }

  // Retry loop
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Rate limit
      const waited = await limiter.acquire();

      if (attempt > 0) {
        if (LOG) console.error(`[llm] Retry ${attempt}/${MAX_RETRIES}`);
      }

      const t0 = Date.now();
      const response = await callGemini(model, body);
      const elapsed = Date.now() - t0;

      const text = extractText(response);

      if (LOG) {
        console.error(`[llm] Response (${elapsed}ms): ${text.slice(0, 300)}...`);
        const usage = response.usageMetadata;
        if (usage) {
          console.error(
            `[llm] Tokens: ${usage.promptTokenCount} in, ` +
            `${usage.candidatesTokenCount} out, ` +
            `${usage.totalTokenCount} total`
          );
        }
      }

      // Parse JSON if schema was provided
      if (schema) {
        try {
          return JSON.parse(text);
        } catch (parseErr) {
          // Gemini's schema enforcement should prevent this, but just in case
          throw new Error(
            `Failed to parse LLM JSON response: ${parseErr.message}\n` +
            `Raw text: ${text.slice(0, 500)}`
          );
        }
      }

      return text;
    } catch (err) {
      lastErr = err;

      if (err.retryable && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        if (LOG) console.error(`[llm] Error (retryable): ${err.message}, waiting ${delay}ms`);
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }

  throw lastErr;
}

/**
 * Check if the LLM client is configured and ready.
 * Returns { ready: boolean, error?: string, models: { fast, smart } }
 */
function status() {
  const ready = !!API_KEY;
  return {
    ready,
    error: ready ? undefined : "GEMINI_API_KEY not set",
    models: {
      fast:  MODEL_FAST,
      smart: MODEL_SMART,
    },
    rateLimits: {
      fast:  limiters.fast.status(),
      smart: limiters.smart.status(),
    },
  };
}

// ─── Schemas (reusable JSON schemas for the engine) ───────────────────────────

/**
 * JSON Schema for the theme interpreter response.
 * Used to enrich tag matches with IGDB terms and abstract concepts.
 */
const THEME_INTERPRETER_SCHEMA = {
  type: "object",
  properties: {
    additional_tags: {
      type: "array",
      description: "2-5 itch.io tag/genre keys (e.g. 'tag-gravity', 'genre-puzzle') from the provided vocabulary that relate to the theme but may not have been caught by fuzzy matching",
      items: { type: "string" },
    },
    creative_concepts: {
      type: "array",
      description: "3-5 abstract concepts the theme evokes (used to guide the narrator, not for retrieval)",
      items: { type: "string" },
    },
    igdb_genres: {
      type: "array",
      description: "1-3 IGDB genre names most likely to contain commercial reference games for this theme (e.g. 'Platformer', 'Puzzle', 'Shooter')",
      items: { type: "string" },
    },
    igdb_themes: {
      type: "array",
      description: "1-2 IGDB theme names that match the feel of this theme (e.g. 'Science fiction', 'Fantasy', 'Horror')",
      items: { type: "string" },
    },
  },
  required: ["additional_tags", "creative_concepts", "igdb_genres", "igdb_themes"],
};

/**
 * JSON Schema for the narrator response.
 * Produces 3-5 rich inspiration paths grounded in real games.
 */
const NARRATOR_SCHEMA = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      description: "3-5 distinct inspiration paths, each a meaningfully different creative direction",
      items: {
        type: "object",
        properties: {
          name:          { type: "string", description: "Short catchy name for this direction (2-5 words)" },
          pitch:         { type: "string", description: "2-3 sentence elevator pitch for a concrete game concept" },
          core_mechanic: { type: "string", description: "The single mechanic to build first — one sentence" },
          why_it_fits:   { type: "string", description: "One sentence explaining how this direction interprets the theme" },
          example_games: {
            type: "array",
            description: "1-3 itch.io games from the provided list that best represent or inspire this direction",
            items: {
              type: "object",
              properties: {
                title:     { type: "string" },
                url:       { type: "string" },
                relevance: { type: "string", description: "One sentence on why this game is relevant to the path" },
              },
              required: ["title", "url", "relevance"],
            },
          },
          reference_games: {
            type: "array",
            description: "0-2 commercial reference games from the provided IGDB list that inspire this direction",
            items: {
              type: "object",
              properties: {
                title:     { type: "string" },
                relevance: { type: "string", description: "One sentence on what to borrow from this game" },
              },
              required: ["title", "relevance"],
            },
          },
          scope_plan: {
            type: "object",
            properties: {
              first_hours:     { type: "string", description: "What to build in the first quarter of available time" },
              if_time_permits: { type: "string", description: "What to add if ahead of schedule" },
              cut_if_behind:   { type: "string", description: "What to cut if behind schedule" },
            },
            required: ["first_hours", "if_time_permits", "cut_if_behind"],
          },
          art_direction: { type: "string", description: "Suggested visual style in one sentence" },
          tone:          { type: "string", description: "Suggested mood/tone in one sentence" },
          title_ideas:   { type: "array", items: { type: "string" }, description: "2 working title ideas" },
          jam_pitch:     { type: "string", description: "One-sentence submission description for the jam page" },
        },
        required: ["name", "pitch", "core_mechanic", "why_it_fits", "example_games", "reference_games", "scope_plan", "art_direction", "tone", "title_ideas", "jam_pitch"],
      },
    },
  },
  required: ["paths"],
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  complete,
  status,
  THEME_INTERPRETER_SCHEMA,
  NARRATOR_SCHEMA,
};