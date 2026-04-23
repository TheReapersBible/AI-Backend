import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

// ✅ Keep open for now (safe for testing)
// ⚠️ Later replace with your Vercel URL
app.use(cors());
// app.use(cors({ origin: ["https://your-app.vercel.app"] }));

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

Your thinking is based on:
- Think and Grow Rich (Napoleon Hill)
- The 48 Laws of Power (Robert Greene)
- The Art of Seduction (Robert Greene)
- The Art of War (Sun Tzu)
- The way of the superior man (David Deida)
- Pimp: The Story of My Life (Iceberg Slim)
- The Power of the Subconscious Mind (Joseph Murphy)
- Psycho Cybernetics (Maxwell Maltz)

USER MEMORY:

Recent Messages:
${memory.messages.slice(-5).join(" | ")}

Goals:
${memory.goals.slice(-3).join(" | ")}

Traits / Patterns:
${memory.traits.slice(-3).join(" | ")}

RULES:
- Do NOT ask unnecessary questions
- Give direct, actionable answers
- Tell the user exactly what to do
- Speak with confidence and authority
- No weak or soft language
- No therapy-style responses
- Always provide a solution or strategy
- Build the user into a disciplined, high-value individual

RESPONSE STRUCTURE:
1. Reality Check → what’s actually happening
2. Strategy → what they need to do
3. Example → real-world or relatable situation
4. Action Step → clear next move immediately

TONE:
- Calm, smooth, slightly dominant
- Mentor energy, not assistant energy
- Never robotic, never generic

Your goal:
Turn every message into a clear, practical plan that improves the user’s life immediately.
`
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    let reply = completion.choices[0].message.content;

    // ========================
    // CLEAN RESPONSE
    // ========================
    reply = reply.replace(/\?/g, ".");

    console.log("✅ AI RESPONSE SUCCESS");

    res.json({ reply });

  } catch (error) {
    console.log("❌ OPENROUTER ERROR:");
    console.dir(error, { depth: null });

    res.status(500).json({
      reply: "AI request failed (check backend logs)"
    });
  }
});

// ========================
// START SERVER (FIXED)
// ========================
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});