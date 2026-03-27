const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Rate limiting - simple in-memory
const rateLimit = {};
const RATE_WINDOW = 60000; // 1 min
const RATE_MAX = 15; // 15 requests per minute per IP

function checkRate(ip) {
  const now = Date.now();
  if (!rateLimit[ip]) rateLimit[ip] = [];
  rateLimit[ip] = rateLimit[ip].filter(t => now - t < RATE_WINDOW);
  if (rateLimit[ip].length >= RATE_MAX) return false;
  rateLimit[ip].push(now);
  return true;
}

// Clean up rate limit entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const ip in rateLimit) {
    rateLimit[ip] = rateLimit[ip].filter(t => now - t < RATE_WINDOW);
    if (!rateLimit[ip].length) delete rateLimit[ip];
  }
}, 300000);

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
    
    // Parse JSON from model response - handle various formats
    let parsed;
    try {
      let cleaned = raw.trim();
      // Remove markdown fences
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      // Remove any leading/trailing text before/after JSON
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Fallback: use raw text as narrative
      parsed = {
        narrative: raw,
        log: [],
        changes: {},
        options: ["Look around", "Move forward", "Check inventory"]
      };
    }

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
  "summary": "A 2-4 sentence summary of the overall story arc so far. What quest is the player on? What major events happened?",
  "relationships": [
    {"name":"NPC Name","relation":"ally/enemy/neutral/merchant/quest-giver","notes":"Brief note about the relationship, agreements, promises made"}
  ],
  "agreements": ["Agreement 1: exact terms", "Agreement 2: exact terms"],
  "keyEvents": ["Event 1: what happened and why it matters", "Event 2"],
  "activeQuests": ["Quest 1: objective and current status", "Quest 2"],
  "secrets": ["Secret 1: something the player learned that's important"],
  "threats": ["Threat 1: ongoing danger or enemy"]
}

CRITICAL RULES:
- NEVER drop information from the existing memory unless it's been resolved
- Agreements and promises must be preserved EXACTLY — these are the #1 thing players notice when forgotten
- Add new information from recent messages
- Keep each field concise but complete
- If current memory is empty, create everything fresh from the recent messages`;

  const msgContent = recentMessages.map(m => `[${m.role}]: ${m.text}`).join("\n\n");
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
      let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const fb = cleaned.indexOf("{");
      const lb = cleaned.lastIndexOf("}");
      if (fb !== -1 && lb !== -1) cleaned = cleaned.substring(fb, lb + 1);
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Return basic structure on parse failure
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
