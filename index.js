import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { connectDB } from "./db.js";
import multer from "multer";

dotenv.config();

const app = express();

app.set("trust proxy", true);

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.options(/.*/, cors());
app.use(express.json());

console.log("SERVER STARTING...");
console.log("API KEY LOADED:", process.env.OPENROUTER_API_KEY ? "YES" : "NO");
console.log("PEXELS KEY LOADED:", process.env.PEXELS_API_KEY ? "YES" : "NO");

/* ========================
   DEBUG ROUTES
======================== */
app.get("/", (req, res) => res.json({ status: "Backend running" }));
app.get("/debug123", (req, res) => res.json({ alive: true, time: Date.now() }));
app.get("/api/test", (req, res) => res.json({ ok: true }));

/* ========================
   UPLOAD
======================== */
const storage = multer.memoryStorage();
const uploadMiddleware = multer({ storage });

app.post("/api/upload", uploadMiddleware.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const cloudinary = await import("cloudinary");
    cloudinary.v2.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    const streamUpload = (fileBuffer) =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.v2.uploader.upload_stream(
          { resource_type: "auto", folder: "ai-media" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(fileBuffer);
      });

    const result = await streamUpload(req.file.buffer);
    return res.json({ url: result.secure_url });

  } catch (error) {
    console.log("UPLOAD ERROR:", error);
    return res.status(500).json({ error: "Upload failed" });
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
   PEXELS HELPERS
======================== */
async function searchPexelsPhotos(query) {
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    const data = await res.json();
    return (data.photos || []).map(p => ({
      url: p.src.large,
      alt: p.alt || query
    }));
  } catch (err) {
    console.log("PEXELS PHOTO ERROR:", err);
    return [];
  }
}

async function searchPexelsVideos(query) {
  try {
    const res = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    const data = await res.json();
    return (data.videos || []).map(v => {
      const file = v.video_files.find(f => f.quality === "hd") || v.video_files[0];
      return { url: file.link };
    });
  } catch (err) {
    console.log("PEXELS VIDEO ERROR:", err);
    return [];
  }
}

/* ========================
   OPENROUTER CLIENT
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
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ reply: "Send a message first.", images: [], videos: [] });
    }

    const userId = getUserId(req);

    if (!userMemory[userId]) {
      userMemory[userId] = { messages: [], goals: [], traits: [] };
    }

    const memory = userMemory[userId];
    memory.messages.push(message);

    const lower = message.toLowerCase();
    if (lower.includes("goal") || lower.includes("want") || lower.includes("need") || lower.includes("trying")) {
      memory.goals.push(message);
    } else {
      memory.traits.push(message);
    }

    /* ---- STEP 1: Ask AI what to say + what media to search ---- */
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

MEDIA RULES — be very strict about these:
- ONLY set imageSearch if the user explicitly asks to see a photo, image, or visual of something specific
- ONLY set videoSearch if the user explicitly asks for a video, tutorial, or wants to see something demonstrated
- For ALL normal conversation, advice, jokes, motivation, and general chat set BOTH to null
- Do NOT send media just because the topic is visual or motivational
- When in doubt, set both to null

Return STRICT JSON ONLY, no markdown, no backticks, no extra text:
{
  "reply": "your response here",
  "imageSearch": null,
  "videoSearch": null
}
`
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    const raw = completion.choices[0].message.content.trim();

    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = { reply: raw, imageSearch: null, videoSearch: null };
    }

    /* ---- STEP 2: Only fetch media if AI explicitly set a search term ---- */
    const [images, videos] = await Promise.all([
      parsed.imageSearch && typeof parsed.imageSearch === "string"
        ? searchPexelsPhotos(parsed.imageSearch)
        : Promise.resolve([]),
      parsed.videoSearch && typeof parsed.videoSearch === "string"
        ? searchPexelsVideos(parsed.videoSearch)
        : Promise.resolve([])
    ]);

    console.log("✅ Reply:", parsed.reply?.slice(0, 60));
    console.log("🖼 Images fetched:", images.length);
    console.log("🎬 Videos fetched:", videos.length);

    return res.json({
      reply: parsed.reply,
      images,
      videos
    });

  } catch (error) {
    console.log("❌ AI ERROR:", error);
    return res.status(500).json({ reply: "AI request failed", images: [], videos: [] });
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