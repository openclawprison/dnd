const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Rate limiting - simple in-memory
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

// Helper: clean narrative text of any JSON artifacts
function cleanNarrativeText(text) {
  if (!text || typeof text !== "string") return "The adventure continues...";
  let t = text;
  t = t.replace(/```json[\s\S]*?```/g, "");
  t = t.replace(/```[\s\S]*?```/g, "");
  t = t.replace(/\{[\s\S]*?"narrative"[\s\S]*?\}/g, "");
  t = t.replace(/\{[\s\S]*?"changes"[\s\S]*?\}/g, "");
  t = t.replace(/\{[\s\S]*?"options"[\s\S]*?\}/g, "");
  t = t.replace(/\{[\s\S]*?"hpChange"[\s\S]*?\}/g, "");
  t = t.replace(/\{[\s\S]*?"log"[\s\S]*?\}/g, "");
  t = t.replace(/\{[\s\S]*?"roll"[\s\S]*?\}/g, "");
  t = t.replace(/^\s*[\{\}\[\]]\s*$/gm, "");
  t = t.replace(/^\s*"[a-zA-Z]+":\s*.+$/gm, "");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t || "The adventure continues...";
}

// Helper: ensure value is a plain string
function ensureString(val) {
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && val.name) return val.name;
  if (val && typeof val === "object") {
    try { return JSON.stringify(val); } catch(e) { return String(val); }
  }
  return String(val || "");
}

// Helper: parse model JSON response with aggressive cleaning
function parseModelResponse(raw) {
  let parsed;
  try {
    let cleaned = raw.trim();
    // Remove ALL markdown fences
    cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
    // Find outermost JSON object
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
    parsed = JSON.parse(cleaned);

    // Validate and clean narrative
    if (parsed.narrative && typeof parsed.narrative === "object") {
      parsed.narrative = parsed.narrative.text || parsed.narrative.content || JSON.stringify(parsed.narrative);
    }
    parsed.narrative = cleanNarrativeText(parsed.narrative || "");
    if (!parsed.narrative) parsed.narrative = "The DM surveys the scene...";

    // Ensure options are plain strings
    if (parsed.options && Array.isArray(parsed.options)) {
      parsed.options = parsed.options.map(o => ensureString(o));
    } else {
      parsed.options = ["Explore the area", "Talk to nearby characters", "Check my equipment", "Continue onward"];
    }

    // Filter out generic options
    const generic = ["look around", "move forward", "check inventory"];
    if (parsed.options.every(o => generic.includes(o.toLowerCase()))) {
      parsed.options = ["Explore the area", "Talk to nearby characters", "Check my equipment", "Continue onward"];
    }

    // Ensure log entries are clean
    if (parsed.log && Array.isArray(parsed.log)) {
      parsed.log = parsed.log.map(l => ({
        type: ensureString(l.type || "info"),
        text: ensureString(l.text || "")
      })).filter(l => l.text);
    } else {
      parsed.log = [];
    }

    // Ensure changes exist
    if (!parsed.changes || typeof parsed.changes !== "object") {
      parsed.changes = {};
    }

    // Ensure newNPCs are strings
    if (parsed.changes.newNPCs && Array.isArray(parsed.changes.newNPCs)) {
      parsed.changes.newNPCs = parsed.changes.newNPCs.map(n => ensureString(n));
    }

    // Ensure enemies are proper objects
    if (parsed.changes.enemies && Array.isArray(parsed.changes.enemies)) {
      parsed.changes.enemies = parsed.changes.enemies.map(e => {
        if (typeof e === "string") return { name: e, hp: 10, maxHp: 10, ac: 12 };
        return {
          name: ensureString(e.name || "Enemy"),
          hp: Number(e.hp) || 10,
          maxHp: Number(e.maxHp) || 10,
          ac: Number(e.ac) || 12
        };
      });
    }

    // Clean roll if present
    if (parsed.roll && typeof parsed.roll === "object") {
      parsed.roll = {
        desc: ensureString(parsed.roll.desc || ""),
        ability: ensureString(parsed.roll.ability || "str"),
        target: Number(parsed.roll.target) || 10,
        type: ensureString(parsed.roll.type || "check")
      };
      if (!parsed.roll.desc) parsed.roll = null;
    } else {
      parsed.roll = null;
    }

    return parsed;

  } catch (e) {
    // Total parse failure — extract whatever readable text we can
    let fallback = raw
      .replace(/```json[\s\S]*?```/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\{[\s\S]*\}/g, "")
      .trim();
    if (!fallback || fallback.length < 10) {
      // Try to extract just the narrative value
      const narMatch = raw.match(/"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (narMatch) fallback = narMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    if (!fallback) fallback = "The adventure continues...";

    return {
      narrative: cleanNarrativeText(fallback),
      roll: null,
      log: [],
      changes: {},
      options: ["Explore the area", "Talk to nearby characters", "Check my equipment", "Continue onward"]
    };
  }
}

app.post("/api/dm", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const ip = req.headers["x-forwarded-for"] || req.ip;
  if (!checkRate(ip)) {
    return res.status(429).json({ error: "Too many requests. Wait a moment." });
  }

  const { system, messages } = req.body;
  if (!system || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Missing system or messages" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: system,
        messages: messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Anthropic API error:", data);
      return res.status(response.status).json({ error: data.error?.message || "API error" });
    }

    if (!data.content || !data.content.length) {
      return res.status(500).json({ error: "Empty response from model" });
    }

    const raw = data.content.map(c => c.text || "").join("");
    const parsed = parseModelResponse(raw);
    res.json(parsed);

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Failed to reach AI service" });
  }
});

// Story memory summarization endpoint
app.post("/api/summarize", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const ip = req.headers["x-forwarded-for"] || req.ip;
  if (!checkRate(ip)) {
    return res.status(429).json({ error: "Too many requests. Wait a moment." });
  }

  const { currentMemory, recentMessages, charName } = req.body;
  if (!recentMessages || !Array.isArray(recentMessages)) {
    return res.status(400).json({ error: "Missing recentMessages" });
  }

  const sysProm = `You are a story memory compressor for a D&D game. The player character is ${charName || 'the adventurer'}.

You will receive the current story memory (may be empty) and recent game messages. Your job is to produce an updated, compressed memory that captures ALL important information.

RESPOND ONLY WITH JSON (no markdown, no backticks):
{
  "summary": "A 2-4 sentence summary of the overall story arc so far.",
  "relationships": [
    {"name":"NPC Name","relation":"ally/enemy/neutral/merchant/quest-giver","notes":"Brief note about the relationship"}
  ],
  "agreements": ["Agreement 1: exact terms", "Agreement 2: exact terms"],
  "keyEvents": ["Event 1: what happened and why it matters"],
  "activeQuests": ["Quest 1: objective and current status"],
  "secrets": ["Secret 1: something the player learned"],
  "threats": ["Threat 1: ongoing danger or enemy"]
}

CRITICAL RULES:
- NEVER drop information from existing memory unless resolved
- Agreements and promises must be preserved EXACTLY
- Add new information from recent messages
- Keep each field concise but complete`;

  const msgContent = recentMessages.map(m => `[${m.role}]: ${ensureString(m.text)}`).join("\n\n");
  const userMsg = `CURRENT MEMORY:\n${currentMemory ? JSON.stringify(currentMemory) : "(empty - first summary)"}\n\nRECENT MESSAGES:\n${msgContent}\n\nProduce the updated memory JSON.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        system: sysProm,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Summarize API error:", data);
      return res.status(response.status).json({ error: data.error?.message || "API error" });
    }

    const raw = (data.content || []).map(c => c.text || "").join("");
    let parsed;
    try {
      let cleaned = raw.trim().replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
      const fb = cleaned.indexOf("{");
      const lb = cleaned.lastIndexOf("}");
      if (fb !== -1 && lb !== -1) cleaned = cleaned.substring(fb, lb + 1);
      parsed = JSON.parse(cleaned);
      // Ensure relationships are clean
      if (parsed.relationships && Array.isArray(parsed.relationships)) {
        parsed.relationships = parsed.relationships.map(r => {
          if (typeof r === "string") return { name: r, relation: "unknown", notes: "" };
          return {
            name: ensureString(r.name || "Unknown"),
            relation: ensureString(r.relation || "unknown"),
            notes: ensureString(r.notes || "")
          };
        });
      }
      // Ensure all arrays contain strings
      ["agreements","keyEvents","activeQuests","secrets","threats"].forEach(key => {
        if (parsed[key] && Array.isArray(parsed[key])) {
          parsed[key] = parsed[key].map(v => ensureString(v));
        }
      });
    } catch (e) {
      parsed = {
        summary: "Story summary unavailable.",
        relationships: [],
        agreements: [],
        keyEvents: [],
        activeQuests: [],
        secrets: [],
        threats: [],
      };
    }

    res.json(parsed);
  } catch (err) {
    console.error("Summarize error:", err);
    res.status(500).json({ error: "Failed to summarize" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`D&D AI DM running on port ${PORT}`);
});