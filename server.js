#!/usr/bin/env node
/**
 * server.js — JamPad Inspiration Engine HTTP server
 *
 * POST /inspire   { theme, timeHours, skillLevel, engine, genres, dimensions, teamSize }
 * GET  /health
 *
 * Usage:
 *   node server.js
 *   PORT=3456 node server.js
 */

"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

// Load .env before requiring anything that needs credentials
try { require("dotenv").config({ path: path.resolve(__dirname, ".env") }); } catch {}

const engine = require("./scripts/inspiration_engine");

const PORT = parseInt(process.env.PORT || "3456", 10);

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  console.log("Initializing inspiration engine...");
  await engine.init();
  console.log("Engine ready.");

  const server = http.createServer(handleRequest);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`JamPad server running on http://localhost:${PORT}`);
    console.log("  POST /inspire — generate inspiration paths");
    console.log("  GET  /health  — health check");
  });
}

// ─── Request handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/debug")) {
    const html = fs.readFileSync(path.join(__dirname, "debug.html"), "utf-8");
    res.setHeader("Content-Type", "text/html");
    res.writeHead(200);
    res.end(html);
    return;
  }

  if (req.method === "POST" && req.url === "/inspire") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    if (!body.theme) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "theme is required" }));
      return;
    }

    try {
      const result = await engine.query(body);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error("[server] Query error:", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ─── Run ──────────────────────────────────────────────────────────────────────

start().catch(err => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
