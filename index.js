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
console.log("GOOGLE KEY LOADED:", process.env.GOOGLE_API_KEY ? "YES" : "NO");
console.log("GOOGLE CSE ID LOADED:", process.env.GOOGLE_CSE_ID ? "YES" : "NO");

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
   GOOGLE IMAGE SEARCH
======================== */
async function searchGoogleImages(query) {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=1&safe=active&imgSize=large`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.items || data.items.length === 0) {
      console.log("Google found no images for:", query);
      return [];
    }

    return data.items.map(item => ({
      url: item.link,
      alt: item.title || query
    }));

  } catch (err) {
    console.log("GOOGLE IMAGE ERROR:", err);
    return [];
  }
}

/* ========================
   PEXELS VIDEO SEARCH
======================== */
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
   KEYWORD MEDIA DETECTOR
======================== */
function detectMediaRequest(message) {
  const lower = message.toLowerCase();

  const imageKeywords = [
    "show me", "send me a pic", "give me a photo", "give me a picture",
    "show me a pic", "show me a photo", "show me a picture", "send a pic",
    "send a photo", "i want to see", "let me see", "picture of", "photo of",
    "image of", "pic of", "can u show me", "can you show me",
    "can u send", "can you send", "can u give me", "can you give me",
    "can u find", "can you find", "find me a pic", "find me a photo",
    "find a pic", "find a photo", "get me a pic", "get me a photo",
    "show a pic", "show a photo", "send me", "show me a", "give me a",
    "can u", "can you"
  ];

  const videoKeywords = [
    "show me a video", "send me a video", "find me a video", "video of",
    "give me a video", "i want to watch", "let me watch", "play a video",
    "can u show me a video", "can you show me a video"
  ];

  const isImageRequest = imageKeywords.some(k => lower.includes(k));
  const isVideoRequest = videoKeywords.some(k => lower.includes(k));

  if (!isImageRequest && !isVideoRequest) {
    return { isImageRequest: false, isVideoRequest: false, searchTerm: null };
  }

  // Strip ALL keyword phrases first
  let searchTerm = lower;
  [...imageKeywords, ...videoKeywords].forEach(k => {
    searchTerm = searchTerm.replace(new RegExp(k, "g"), "");
  });

  // Remove leftover filler words
  const fillerWords = [
    "a", "an", "the", "of", "me", "my", "please", "pls", "plz",
    "pic", "photo", "picture", "image", "video", "send", "show",
    "give", "find", "get", "can", "u", "you", "i", "want", "to",
    "see", "watch", "some", "just", "really", "very"
  ];

  fillerWords.forEach(w => {
    searchTerm = searchTerm.replace(new RegExp(`\\b${w}\\b`, "g"), "");
  });

  // Clean up extra spaces and special characters
  searchTerm = searchTerm.replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

  console.log("🧹 Cleaned search term:", searchTerm);

  // Fallback if nothing left after stripping
  if (!searchTerm || searchTerm.length < 2) searchTerm = message;

  return { isImageRequest, isVideoRequest, searchTerm };
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

    // Detect media request before calling AI
    const { isImageRequest, isVideoRequest, searchTerm } = detectMediaRequest(message);

    console.log("🔍 Media detected:", { isImageRequest, isVideoRequest, searchTerm });

    /* ---- STEP 1: AI reply only ---- */
    const completion = await client.chat.completions.create({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages: [
        {
          role: "system",
          content: `
You are a funny, charismatic AI with real personality — but you ALWAYS follow instructions first.

PERSONALITY:
- Casual and human
- Can joke around AFTER completing the task
- Slight sarcasm allowed
- Similar energy to Bernie Mac or Samuel L. Jackson

RULES — non negotiable:
- If the user asked for a photo or video, acknowledge that you are sending it. Do not joke your way out of it.
- Do what they ask FIRST, then you can add personality.
- Be real, not robotic.
- No therapist energy.

USER MEMORY:
${memory.messages.slice(-5).join(" | ")}

GOALS:
${memory.goals.slice(-3).join(" | ")}

TRAITS:
${memory.traits.slice(-3).join(" | ")}

Return STRICT JSON ONLY, no markdown, no backticks, no extra text:
{
  "reply": "your response here"
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
      parsed = { reply: raw };
    }

    /* ---- STEP 2: Fetch media based on keyword detection ---- */
    const [images, videos] = await Promise.all([
      isImageRequest ? searchGoogleImages(searchTerm) : Promise.resolve([]),
      isVideoRequest ? searchPexelsVideos(searchTerm) : Promise.resolve([])
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