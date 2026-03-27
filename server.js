const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

const rateLimit = {};
const RATE_WINDOW = 60000;
const RATE_MAX = 15;

function checkRate(ip) {
  const now = Date.now();
  if (!rateLimit[ip]) rateLimit[ip] = [];
  rateLimit[ip] = rateLimit[ip].filter(t => now - t < RATE_WINDOW);
  if (rateLimit[ip].length >= RATE_MAX) return false;
  rateLimit[ip].push(now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const ip in rateLimit) {
    rateLimit[ip] = rateLimit[ip].filter(t => now - t < RATE_WINDOW);
    if (!rateLimit[ip].length) delete rateLimit[ip];
  }
}, 300000);

function ensureString(val) {
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && val.name) return val.name;
  if (val && typeof val === "object") {
    try { return JSON.stringify(val); } catch(e) { return String(val); }
  }
  return String(val || "");
}

// Extract clean narrative text - handles double-encoded JSON, code fences, and partial JSON
function extractNarrative(text, depth) {
  if (!depth) depth = 0;
  if (depth > 3) return "The adventure continues...";
  if (!text) return "The adventure continues...";
  if (typeof text === "object") {
    if (text.narrative) return extractNarrative(text.narrative, depth + 1);
    if (text.text) return extractNarrative(text.text, depth + 1);
    return "The adventure continues...";
  }
  if (typeof text !== "string") return "The adventure continues...";

  let t = text.trim();

  // Strip code fences first
  t = t.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

  // If it looks like JSON, try to parse and extract narrative
  if (t.startsWith("{")) {
    try {
      const obj = JSON.parse(t);
      if (obj.narrative && typeof obj.narrative === "string") {
        return extractNarrative(obj.narrative, depth + 1);
      }
    } catch(e) {
      // Try regex to grab the narrative value from malformed JSON
      const m = t.match(/"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m && m[1].length > 20) {
        return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      // Strip all JSON and return whatever text remains
      t = t.replace(/\{[\s\S]*\}/g, "").trim();
    }
  }

  // Remove any remaining JSON-like fragments
  if (t.includes('"narrative"') || t.includes('"changes"') || t.includes('"options"')) {
    const m = t.match(/"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m && m[1].length > 20) {
      return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    t = t.replace(/\{[\s\S]*\}/g, "").trim();
  }

  // Clean leftover JSON syntax
  t = t.replace(/^\s*[\{\}\[\],"]+\s*$/gm, "");
  t = t.replace(/^\s*"[a-zA-Z_]+":\s*/gm, "");
  t = t.replace(/^\s*,\s*$/gm, "");
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return t || "The adventure continues...";
}

function parseModelResponse(raw) {
  // Step 1: Try to parse as JSON
  let parsed = null;
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

  // Find outermost JSON
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      parsed = JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
    } catch(e) {
      parsed = null;
    }
  }

  // Step 2: If parse failed, try to extract narrative with regex
  if (!parsed) {
    const narText = extractNarrative(raw, 0);
    return {
      narrative: narText,
      roll: null,
      log: [],
      changes: {},
      options: ["Explore the area", "Talk to nearby characters", "Check my equipment", "Continue onward"]
    };
  }

  // Step 3: Clean the parsed response
  // Narrative - extract cleanly, handle if it's double-encoded
  parsed.narrative = extractNarrative(parsed.narrative || "", 0);

  // Options - ensure plain strings, no generics
  if (parsed.options && Array.isArray(parsed.options)) {
    parsed.options = parsed.options.map(o => ensureString(o));
  } else {
    parsed.options = [];
  }
  const generic = ["look around", "move forward", "check inventory"];
  if (parsed.options.length === 0 || parsed.options.every(o => generic.includes(o.toLowerCase().trim()))) {
    parsed.options = ["Explore the area", "Talk to nearby characters", "Check my equipment", "Continue onward"];
  }

  // Log - ensure clean
  if (parsed.log && Array.isArray(parsed.log)) {
    parsed.log = parsed.log.map(l => ({
      type: ensureString(l.type || "info"),
      text: ensureString(l.text || "")
    })).filter(l => l.text);
  } else {
    parsed.log = [];
  }

  // Changes
  if (!parsed.changes || typeof parsed.changes !== "object") {
    parsed.changes = {};
  }
  if (parsed.changes.newNPCs && Array.isArray(parsed.changes.newNPCs)) {
    parsed.changes.newNPCs = parsed.changes.newNPCs.map(n => ensureString(n));
  }
  if (parsed.changes.enemies && Array.isArray(parsed.changes.enemies)) {
    parsed.changes.enemies = parsed.changes.enemies.map(e => {
      if (typeof e === "string") return { name: e, hp: 10, maxHp: 10, ac: 12 };
      return { name: ensureString(e.name || "Enemy"), hp: Number(e.hp)||10, maxHp: Number(e.maxHp)||10, ac: Number(e.ac)||12 };
    });
  }

  // Roll
  if (parsed.roll && typeof parsed.roll === "object" && parsed.roll.desc) {
    parsed.roll = {
      desc: ensureString(parsed.roll.desc),
      ability: ensureString(parsed.roll.ability || "str"),
      target: Number(parsed.roll.target) || 10,
      type: ensureString(parsed.roll.type || "check")
    };
  } else {
    parsed.roll = null;
  }

  return parsed;
}

app.post("/api/dm", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  const ip = req.headers["x-forwarded-for"] || req.ip;
  if (!checkRate(ip)) return res.status(429).json({ error: "Too many requests. Wait a moment." });
  const { system, messages } = req.body;
  if (!system || !messages || !Array.isArray(messages)) return res.status(400).json({ error: "Missing system or messages" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, system, messages }),
    });
    const data = await response.json();
    if (!response.ok) { console.error("API error:", data); return res.status(response.status).json({ error: data.error?.message || "API error" }); }
    if (!data.content || !data.content.length) return res.status(500).json({ error: "Empty response" });

    const raw = data.content.map(c => c.text || "").join("");
    const parsed = parseModelResponse(raw);

    // Final safety check - if narrative still contains JSON-like content, log it
    if (parsed.narrative.includes('"narrative"') || parsed.narrative.includes('"changes"')) {
      console.warn("WARNING: narrative still contains JSON after cleaning. Raw length:", raw.length);
      // Nuclear option - regex extract one more time
      const m = raw.match(/"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m && m[1].length > 20) {
        parsed.narrative = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Failed to reach AI service" });
  }
});

app.post("/api/summarize", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  const ip = req.headers["x-forwarded-for"] || req.ip;
  if (!checkRate(ip)) return res.status(429).json({ error: "Too many requests." });
  const { currentMemory, recentMessages, charName } = req.body;
  if (!recentMessages || !Array.isArray(recentMessages)) return res.status(400).json({ error: "Missing recentMessages" });

  const sysProm = `You are a story memory compressor for a D&D game. The player character is ${charName || 'the adventurer'}.
RESPOND ONLY WITH JSON (no markdown, no backticks):
{"summary":"2-4 sentence summary","relationships":[{"name":"NPC","relation":"ally/enemy/neutral","notes":"brief note"}],"agreements":["exact terms"],"keyEvents":["what happened"],"activeQuests":["objective and status"],"secrets":["what was learned"],"threats":["ongoing danger"]}
NEVER drop existing memory unless resolved. Agreements must be preserved EXACTLY.`;

  const msgContent = recentMessages.map(m => `[${m.role}]: ${ensureString(m.text)}`).join("\n\n");
  const userMsg = `CURRENT MEMORY:\n${currentMemory ? JSON.stringify(currentMemory) : "(empty)"}\n\nRECENT:\n${msgContent}\n\nProduce updated memory.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 800, system: sysProm, messages: [{ role: "user", content: userMsg }] }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "API error" });
    const raw = (data.content || []).map(c => c.text || "").join("");
    let parsed;
    try {
      let cl = raw.trim().replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
      const fb = cl.indexOf("{"); const lb = cl.lastIndexOf("}");
      if (fb !== -1 && lb !== -1) cl = cl.substring(fb, lb + 1);
      parsed = JSON.parse(cl);
      if (parsed.relationships) parsed.relationships = parsed.relationships.map(r => typeof r === "string" ? { name: r, relation: "unknown", notes: "" } : { name: ensureString(r.name||"Unknown"), relation: ensureString(r.relation||"unknown"), notes: ensureString(r.notes||"") });
      ["agreements","keyEvents","activeQuests","secrets","threats"].forEach(k => { if (parsed[k] && Array.isArray(parsed[k])) parsed[k] = parsed[k].map(v => ensureString(v)); });
    } catch (e) {
      parsed = { summary:"Summary unavailable.", relationships:[], agreements:[], keyEvents:[], activeQuests:[], secrets:[], threats:[] };
    }
    res.json(parsed);
  } catch (err) {
    console.error("Summarize error:", err);
    res.status(500).json({ error: "Failed to summarize" });
  }
});

app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, () => { console.log(`Tale Weavers running on port ${PORT}`); });