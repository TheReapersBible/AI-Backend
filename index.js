import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

// ========================
// ✅ CORS FIX (Vercel + local + safety)
// ========================
app.use(cors({
  origin: [
    "https://winners-image.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// MUST handle preflight requests (fixes Failed to fetch)
app.options(/.*/, cors());

app.use(express.json());

console.log("SERVER STARTING...");
console.log("API KEY LOADED:", process.env.OPENROUTER_API_KEY ? "YES" : "NO");

// ========================
// 🧠 MEMORY STORE (RAM)
// ========================
const userMemory = {};

// simple user id (for now)
function getUserId(req) {
  return req.ip;
}

// OpenRouter client
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// ========================
// TEST ROUTE
// ========================
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// ========================
// AI ROUTE (WITH MEMORY)
// ========================
app.post("/api/ai", async (req, res) => {
  console.log("🔥 HIT /api/ai ROUTE");

  const { message } = req.body;
  const userId = getUserId(req);

  if (!message) {
    return res.status(400).json({ reply: "No message provided" });
  }

  // ========================
  // INIT MEMORY IF NEW USER
  // ========================
  if (!userMemory[userId]) {
    userMemory[userId] = {
      messages: [],
      goals: [],
      traits: []
    };
  }

  const memory = userMemory[userId];

  // ========================
  // STORE USER INPUT
  // ========================
  memory.messages.push(message);

  const lowerMsg = message.toLowerCase();

  if (
    lowerMsg.includes("goal") ||
    lowerMsg.includes("want") ||
    lowerMsg.includes("need") ||
    lowerMsg.includes("trying to")
  ) {
    memory.goals.push(message);
  } else {
    memory.traits.push(message);
  }

  console.log("🧠 MEMORY STATE:", memory);

  try {
    console.log("CALLING OPENROUTER...");

    const completion = await client.chat.completions.create({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages: [
        {
          role: "system",
          content: `
You are a powerful, strategic mentor who builds winners.

USER MEMORY:
${memory.messages.slice(-5).join(" | ")}

GOALS:
${memory.goals.slice(-3).join(" | ")}

TRAITS:
${memory.traits.slice(-3).join(" | ")}

RULES:
- Direct answers
- No fluff
- Actionable steps
`
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    let reply = completion.choices[0].message.content;
    reply = reply.replace(/\?/g, ".");

    console.log("✅ AI RESPONSE SUCCESS");

    res.json({ reply });

  } catch (error) {
    console.log("❌ OPENROUTER ERROR:");
    console.dir(error, { depth: null });

    res.status(500).json({
      reply: "AI request failed"
    });
  }
});

// ========================
// START SERVER (Render safe port)
// ========================
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});