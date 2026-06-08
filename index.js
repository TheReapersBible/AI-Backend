import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { connectDB } from "./db.js";
import multer from "multer";
import mongoose from "mongoose";

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
   MONGODB SCHEMAS
======================== */
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  goals: [String],
  traits: [String],
  alterEgo: {
    name: String,
    traits: [String],
    mission: String,
    active: { type: Boolean, default: false }
  },
  winScore: { type: Number, default: 5 },
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  userId: String,
  role: String,
  text: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Message = mongoose.models.Message || mongoose.model("Message", messageSchema);

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
   GOOGLE IMAGE SEARCH
======================== */
async function searchGoogleImages(query) {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=1&safe=active`;
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

  let searchTerm = lower;
  [...imageKeywords, ...videoKeywords].forEach(k => {
    searchTerm = searchTerm.replace(new RegExp(k, "g"), "");
  });

  const fillerWords = [
    "a", "an", "the", "of", "me", "my", "please", "pls", "plz",
    "pic", "photo", "picture", "image", "video", "send", "show",
    "give", "find", "get", "can", "u", "you", "i", "want", "to",
    "see", "watch", "some", "just", "really", "very"
  ];

  fillerWords.forEach(w => {
    searchTerm = searchTerm.replace(new RegExp(`\\b${w}\\b`, "g"), "");
  });

  searchTerm = searchTerm.replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  console.log("🧹 Cleaned search term:", searchTerm);

  if (!searchTerm || searchTerm.length < 2) searchTerm = message;

  return { isImageRequest, isVideoRequest, searchTerm };
}

/* ========================
   MIRROR TALK DETECTOR
======================== */
function needsMirrorTalk(message) {
  const lower = message.toLowerCase();
  const triggers = [
    "i don't know", "i dont know", "i can't", "i cant",
    "i'm not sure", "im not sure", "maybe i should just",
    "i give up", "it's hard", "its hard", "i'm lost", "im lost",
    "i don't think i can", "i dont think i can", "what's the point",
    "whats the point", "be real with me", "mirror talk",
    "am i doing enough", "i feel stuck", "i'm stuck", "im stuck",
    "i don't know what to do", "i dont know what to do",
    "i'm failing", "im failing", "i feel like giving up"
  ];
  return triggers.some(t => lower.includes(t));
}

/* ========================
   ALTER EGO DETECTOR
======================== */
function isAlterEgoRequest(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("create my alter ego") ||
    lower.includes("make my alter ego") ||
    lower.includes("set up my alter ego") ||
    lower.includes("change my alter ego") ||
    lower.includes("update my alter ego")
  );
}

/* ========================
   WIN SCORE CALCULATOR
======================== */
function calculateWinScore(message, goals) {
  const lower = message.toLowerCase();
  let score = 5;

  const positiveSignals = [
    "i did", "i finished", "i completed", "i worked out", "i saved",
    "i woke up early", "i read", "i studied", "i practiced",
    "i accomplished", "i achieved", "i hit my goal", "i stayed consistent",
    "i didn't", "i resisted", "i said no"
  ];

  const negativeSignals = [
    "i wasted", "i spent", "i skipped", "i didn't work out",
    "i slept in", "i gave up", "i failed", "i couldn't",
    "i procrastinated", "i was lazy", "i blew it"
  ];

  positiveSignals.forEach(s => { if (lower.includes(s)) score += 1; });
  negativeSignals.forEach(s => { if (lower.includes(s)) score -= 1; });

  // Check alignment with goals
  if (goals && goals.length > 0) {
    goals.forEach(goal => {
      const goalWords = goal.toLowerCase().split(" ");
      goalWords.forEach(word => {
        if (word.length > 4 && lower.includes(word)) score += 0.5;
      });
    });
  }

  return Math.min(10, Math.max(1, Math.round(score)));
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
      return res.status(400).json({
        reply: "Send a message first.",
        images: [],
        videos: [],
        winScore: null,
        mirrorTalk: null,
        alterEgoActive: false
      });
    }

    const userId = req.ip || "unknown-user";

    // Load or create user from MongoDB
    let user = await User.findOne({ userId });
    if (!user) {
      user = await User.create({ userId, goals: [], traits: [], winScore: 5 });
    }

    // Save user message to MongoDB
    await Message.create({ userId, role: "user", text: message });

    // Load last 10 messages from MongoDB for context
    const recentMessages = await Message.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    const history = recentMessages.reverse().map(m => m.text);

    // Update goals and traits
    const lower = message.toLowerCase();
    if (
      lower.includes("goal") || lower.includes("want") ||
      lower.includes("need") || lower.includes("trying") ||
      lower.includes("i want to") || lower.includes("my goal")
    ) {
      user.goals.push(message);
      if (user.goals.length > 10) user.goals = user.goals.slice(-10);
    } else {
      user.traits.push(message);
      if (user.traits.length > 10) user.traits = user.traits.slice(-10);
    }

    // Detect features
    const { isImageRequest, isVideoRequest, searchTerm } = detectMediaRequest(message);
    const mirrorTalkNeeded = needsMirrorTalk(message);
    const alterEgoRequest = isAlterEgoRequest(message);
    const winScore = calculateWinScore(message, user.goals);

    // Update win score with rolling average
    user.winScore = Math.round((user.winScore + winScore) / 2);
    await user.save();

    console.log("🔍 Media detected:", { isImageRequest, isVideoRequest, searchTerm });
    console.log("🪞 Mirror talk needed:", mirrorTalkNeeded);
    console.log("🦸 Alter ego request:", alterEgoRequest);
    console.log("🏆 WIN Score:", winScore);

    // Build system prompt
    let systemPrompt = `
You are a funny, charismatic AI life coach with real personality — but you ALWAYS follow instructions first.

PERSONALITY:
- Casual and human
- Similar energy to Bernie Mac or Samuel L. Jackson
- Joke around AFTER completing the task
- Slight sarcasm allowed
- No therapist energy

USER PROFILE:
Goals: ${user.goals.slice(-5).join(" | ") || "Not set yet"}
Traits: ${user.traits.slice(-5).join(" | ") || "Unknown"}
WIN Score: ${user.winScore}/10
Conversation History: ${history.slice(-5).join(" | ")}
`;

    if (user.alterEgo?.active) {
      systemPrompt += `
ALTER EGO ACTIVE:
The user's alter ego is "${user.alterEgo.name}".
Traits: ${user.alterEgo.traits?.join(", ")}
Mission: ${user.alterEgo.mission}
Speak to them AS their alter ego — remind them who they decided to become. Push them to embody it.
`;
    }

    if (alterEgoRequest) {
      systemPrompt += `
The user wants to create or update their alter ego.
Walk them through it conversationally — ask:
1. What do you want your alter ego to be named?
2. What are 3 traits this version of you has that you are still building?
3. What is their mission in one sentence?
Tell them their alter ego is now active and you will hold them to it.
`;
    }

    if (mirrorTalkNeeded) {
      systemPrompt += `
MIRROR TALK MODE — the user seems lost, stuck, or unsure.
Be funny but brutally honest. Call out what they said in relation to their goals.
Example: if their goal is saving money but they keep spending, say something like 
"Bruh you told me you wanted to save money... so why does your wallet look like it's on a first date every weekend?"
Make it funny, relatable, and tie it back to their actual goals.
Push them forward with humor and truth — not harshness.
`;
    }

    systemPrompt += `
RULES — non negotiable:
- If the user asked for a photo or video acknowledge you are sending it
- Do what they ask FIRST then add personality
- Be real not robotic
- Always tie feedback back to their stated goals

Return STRICT JSON ONLY, no markdown, no backticks, no extra text:
{
  "reply": "your response here"
}
`;

    const completion = await client.chat.completions.create({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
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

    // Save AI reply to MongoDB
    await Message.create({ userId, role: "ai", text: parsed.reply });

    // Handle alter ego creation — parse from reply and save
    if (alterEgoRequest) {
      user.alterEgo = {
        ...user.alterEgo,
        active: true
      };
      await user.save();
    }

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
      videos,
      winScore,
      mirrorTalk: mirrorTalkNeeded,
      alterEgoActive: user.alterEgo?.active || false
    });

  } catch (error) {
    console.log("❌ AI ERROR:", error);
    return res.status(500).json({
      reply: "AI request failed",
      images: [],
      videos: [],
      winScore: null,
      mirrorTalk: null,
      alterEgoActive: false
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