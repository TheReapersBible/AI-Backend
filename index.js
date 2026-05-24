import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { connectDB } from "./db.js";
import { upload } from "./upload.js";

dotenv.config();

const app = express();

/* ========================
   TRUST PROXY
======================== */
app.set("trust proxy", true);

/* ========================
   CORS FIX
======================== */
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// Express v5 safe preflight handler
app.options(/.*/, cors());

app.use(express.json());

console.log("SERVER STARTING...");
console.log(
  "API KEY LOADED:",
  process.env.OPENROUTER_API_KEY ? "YES" : "NO"
);

/* ========================
   DEBUG ROUTES
======================== */
app.get("/", (req, res) => {
  res.json({
    status: "Backend running"
  });
});

app.get("/debug123", (req, res) => {
  res.json({
    alive: true,
    time: Date.now()
  });
});

app.get("/api/test", (req, res) => {
  res.json({
    ok: true
  });
});

/* ========================
   UPLOAD ROUTE (NEW)
======================== */
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    res.json({
      url: req.file.path
    });
  } catch (error) {
    res.status(500).json({
      error: "Upload failed"
    });
  }
});

/* ========================
   MEMORY
======================== */
const userMemory = {};

function getUserId(req) {
  return req.ip || "unknown-user";
}

/* ========================
   OPENROUTER
======================== */
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY
});

/* ========================
   AI ROUTE
======================== */
app.post("/api/ai", async (req, res) => {
  console.log("🔥 HIT /api/ai ROUTE");

  try {
    const {
      message,
      images = [],
      videos = []
    } = req.body;

    if (!message) {
      return res.status(400).json({
        reply: "Send a message first.",
        images: [],
        videos: []
      });
    }

    const userId = getUserId(req);

    if (!userMemory[userId]) {
      userMemory[userId] = {
        messages: [],
        goals: [],
        traits: []
      };
    }

    const memory = userMemory[userId];

    memory.messages.push(message);

    const lower = message.toLowerCase();

    if (
      lower.includes("goal") ||
      lower.includes("want") ||
      lower.includes("need") ||
      lower.includes("trying")
    ) {
      memory.goals.push(message);
    } else {
      memory.traits.push(message);
    }

    const completion = await client.chat.completions.create({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages: [
        {
          role: "system",
          content: `
You are a funny, charismatic AI with real personality.

STYLE:
- Casual and human
- Can joke around
- Slight sarcasm allowed
- A lot of profanity allowed
- Not robotic
- Similar energy to Bernie Mac or Samuel L. Jackson

USER MEMORY:
${memory.messages.slice(-5).join(" | ")}

GOALS:
${memory.goals.slice(-3).join(" | ")}

TRAITS:
${memory.traits.slice(-3).join(" | ")}

IMPORTANT:
- Connect naturally and emotionally
- Joke sometimes
- Be real, not robotic
- No therapist energy

Return STRICT JSON ONLY:
{
  "reply": "response",
  "images": [],
  "videos": []
}
`
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    const raw = completion.choices[0].message.content;

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        reply: raw,
        images: [],
        videos: []
      };
    }

    return res.json(parsed);

  } catch (error) {
    console.log("❌ AI ERROR:", error);

    return res.status(500).json({
      reply: "AI request failed",
      images: [],
      videos: []
    });
  }
});

/* ========================
   START SERVER
======================== */
const PORT = process.env.PORT || 3001;

connectDB().catch(err => console.log(err));

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});