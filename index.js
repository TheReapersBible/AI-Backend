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
console.log("GOOGLE KEY LOADED:", process.env.GOOGLE_API_KEY ? "YES" : "NO");
console.log("PEXELS KEY LOADED:", process.env.PEXELS_API_KEY ? "YES" : "NO");

/* ========================
   MONGODB SCHEMAS
======================== */
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  profile: {
    identityStatement: String,
    affirmations: [String],
    dailyPlan: String,
    answers: mongoose.Schema.Types.Mixed
  },
  goals: [String],
  traits: [String],
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
          (error, result) => { if (error) reject(error); else resolve(result); }
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
    if (!data.items || data.items.length === 0) return [];
    return data.items.map(item => ({ url: item.link, alt: item.title || query }));
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
   GOOGLE TTS VOICE
======================== */
app.post("/api/speak", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "No text provided" });
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: "en-US", name: "en-US-Neural2-D" },
          audioConfig: { audioEncoding: "MP3", speakingRate: 0.92, pitch: -4.0 }
        })
      }
    );
    if (!response.ok) {
      const err = await response.text();
      console.log("GOOGLE TTS ERROR:", err);
      return res.status(500).json({ error: "Voice generation failed" });
    }
    const data = await response.json();
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(data.audioContent, "base64"));
  } catch (err) {
    console.log("SPEAK ROUTE ERROR:", err);
    res.status(500).json({ error: "Voice generation failed" });
  }
});

/* ========================
   OPENROUTER CLIENT
======================== */
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY
});

/* ========================
   CREATE WINNER'S IMAGE PROFILE
======================== */
app.post("/api/create-profile", async (req, res) => {
  try {
    const { answers } = req.body;

    const prompt = `
You are analyzing someone's Winner's Image Assessment to create their personalized identity profile.

Here are their answers:

Question 1 - Their Ideal Self:
${answers.idealSelf}

Question 2 - Their Ideal Environment:
${answers.environment}

Question 3 - Their Mental Barriers:
${answers.mentalBarriers}

Question 4 - Their Past:
${answers.past}

Question 5 - Satisfaction vs Growth:
${answers.satisfaction}

Question 6 - The Cost of Staying the Same:
${answers.costOfSame}

Based on these answers, create:

1. An IDENTITY STATEMENT — 2-3 sentences that define who they are becoming. Use second person ("You are..."). Make it powerful, specific to what they shared, emotionally resonant. Not generic. Reference the specific things they said about their ideal self and what they're leaving behind.

2. CUSTOM AFFIRMATIONS — 5 affirmations tailored specifically to their mental barriers and past. If they struggle with doubt, create affirmations about certainty. If they have past trauma, create affirmations about release and forward movement. If they want financial success, create affirmations about abundance and value creation. Make them present tense, emotionally strong, personal to what they shared.

3. DAILY PLAN — 3-4 sentences describing their personalized daily identity practice: morning (read identity statement, say affirmations out loud, visualize), day (3 actions toward their specific goal), night (check-in reflection). Reference their specific goals from question 1.

Return STRICT JSON ONLY, no markdown, no backticks:
{
  "identityStatement": "...",
  "affirmations": ["...", "...", "...", "...", "..."],
  "dailyPlan": "..."
}
`;

    const completion = await client.chat.completions.create({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }]
    });

    const raw = completion.choices[0].message.content.trim();
    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = {
        identityStatement: "You are becoming the most disciplined, focused, and unstoppable version of yourself. You no longer allow doubt or past experiences to define your future. You are building a life aligned with your highest potential.",
        affirmations: [
          "I act with confidence even when I feel uncertain.",
          "My past does not define my future.",
          "I am becoming who I was always meant to be.",
          "I follow through on what I say I will do.",
          "I deserve the life I am building."
        ],
        dailyPlan: "Every morning read your identity statement out loud, say your affirmations with conviction, then close your eyes and visualize your ideal self for 5 minutes. During the day complete 3 actions that move you toward your goal. Every night reflect on whether your actions matched the person you are becoming."
      };
    }

    return res.json(parsed);

  } catch (error) {
    console.log("CREATE PROFILE ERROR:", error);
    return res.status(500).json({
      identityStatement: "You are becoming the most disciplined and focused version of yourself.",
      affirmations: ["I am becoming who I said I would be.", "My past does not define my future.", "I act with faith not fear."],
      dailyPlan: "Read your identity statement every morning, say your affirmations out loud, visualize your future self for 5 minutes."
    });
  }
});

/* ========================
   KEYWORD MEDIA DETECTOR
======================== */
function detectMediaRequest(message) {
  const lower = message.toLowerCase();
  const imageKeywords = [
    "show me a picture of", "show me a photo of", "show me a pic of",
    "send me a picture of", "send me a photo of", "send me a pic of",
    "give me a picture of", "give me a photo of", "give me a pic of",
    "find me a picture of", "find me a photo of", "find me a pic of",
    "can you show me a picture of", "can you send me a picture of",
    "can u show me a picture of", "can u send me a picture of",
    "i want to see a picture of", "i want to see a photo of",
    "picture of", "photo of", "image of", "pic of",
    "show me", "send me", "give me", "find me"
  ];
  const videoKeywords = [
    "show me a video of", "send me a video of", "find me a video of",
    "give me a video of", "video of"
  ];
  const isImageRequest = imageKeywords.some(k => lower.includes(k));
  const isVideoRequest = videoKeywords.some(k => lower.includes(k));
  if (!isImageRequest && !isVideoRequest) {
    return { isImageRequest: false, isVideoRequest: false, searchTerm: null };
  }
  const allKeywords = [...imageKeywords, ...videoKeywords].sort((a, b) => b.length - a.length);
  let searchTerm = message;
  for (const k of allKeywords) {
    const idx = lower.indexOf(k);
    if (idx !== -1) { searchTerm = message.slice(idx + k.length).trim(); break; }
  }
  searchTerm = searchTerm.replace(/[^a-zA-Z0-9 ]/g, "").trim();
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
   AI ROUTE
======================== */
app.post("/api/ai", async (req, res) => {
  console.log("🔥 HIT /api/ai ROUTE");

  try {
    const { message, profile, actAsIfMode } = req.body;

    if (!message) {
      return res.status(400).json({ reply: "Send a message first.", images: [], videos: [] });
    }

    const userId = req.ip || "unknown-user";

    let user = await User.findOne({ userId });
    if (!user) {
      user = await User.create({ userId, goals: [], traits: [] });
    }

    if (profile && profile.identityStatement) {
      user.profile = profile;
      await user.save();
    }

    await Message.create({ userId, role: "user", text: message });

    const recentMessages = await Message.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    const history = recentMessages.reverse().map(m => m.text);

    const lower = message.toLowerCase();
    if (lower.includes("goal") || lower.includes("want") || lower.includes("need") || lower.includes("trying")) {
      user.goals.push(message);
      if (user.goals.length > 10) user.goals = user.goals.slice(-10);
    } else {
      user.traits.push(message);
      if (user.traits.length > 10) user.traits = user.traits.slice(-10);
    }
    await user.save();

    const { isImageRequest, isVideoRequest, searchTerm } = detectMediaRequest(message);
    const mirrorTalkNeeded = needsMirrorTalk(message);
    const activeProfile = profile || user.profile || {};
    const actAsIf = actAsIfMode || false;

    console.log("🔍 Media detected:", { isImageRequest, isVideoRequest, searchTerm });
    console.log("🪞 Mirror talk needed:", mirrorTalkNeeded);

    let systemPrompt = `
You are a Southern, Bernie Mac energy life coach — real, funny, deeply wise. You genuinely care about this person and you talk like it.

${activeProfile.identityStatement ? `
THE USER'S WINNER'S IMAGE PROFILE:

Identity Statement: ${activeProfile.identityStatement}

Their Affirmations: ${activeProfile.affirmations?.join(" | ") || "not set"}

What they said their ideal self looks like: ${activeProfile.answers?.idealSelf || "not set"}

Their mental barriers: ${activeProfile.answers?.mentalBarriers || "not set"}

Their past that still affects them: ${activeProfile.answers?.past || "not set"}

What drives them: ${activeProfile.answers?.satisfaction || "not set"}

What happens if nothing changes: ${activeProfile.answers?.costOfSame || "not set"}

THIS IS THEIR NORTH STAR. Reference it. Use their specific words. When they drift, bring them back to who they said they're becoming. The AI's job is to constantly remind them: "This is who you're becoming. Now act like it."
` : "This user hasn't completed their Winner's Image Assessment yet. Encourage them to tap the My Image tab to complete it — that's where everything starts."}

${actAsIf ? `
ACT AS IF MODE IS ACTIVE:
This person has committed to being their future self TODAY. Speak to them as if they already ARE that person — not becoming, they ARE. Every word should reinforce their identity, not their current circumstances.
` : ""}

HARD RULES — NEVER break these:
- NEVER use numbered lists or bullet points
- NEVER use bold text, asterisks, or markdown
- NEVER say "bless your heart", "sweetheart", "my friend", "darling"
- NEVER start with "Here are", "Here's", "Sure!", "Of course!"
- Short punchy sentences, one or two at a time
- Curse occasionally — damn, hell, man, bruh
- React to the person first, the problem second
- No corporate speak, no therapy speak, no robot speak
- If they share something vulnerable, sit with it before jumping to advice

ADVICE QUALITY:
- Specific and actionable, tied to their actual profile above
- Not generic — reference their specific words and situations
- If they drift from their identity, call it out with humor and truth
- If they're doing well, acknowledge it and push them further

CONVERSATION HISTORY:
${history.slice(-5).join(" | ")}
`;

    if (mirrorTalkNeeded) {
      systemPrompt += `
MIRROR TALK MODE:
They seem lost or stuck. Pull no punches but do it with care.
Reference their identity statement specifically. Ask if they've been saying their affirmations out loud.
Tie everything back to what they said about the cost of staying the same — that's the urgency.
One or two sentences. Hit hard with love and move on.
`;
    }

    systemPrompt += `
NON NEGOTIABLE:
- If asked for a photo or video just say you're sending it — one sentence
- Do what they ask FIRST then add personality
- NEVER use lists or formatting

Return STRICT JSON ONLY:
{
  "reply": "your response here"
}
`;

    const completion = await client.chat.completions.create({
      model: "openai/gpt-4o-mini",
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

    if (parsed.reply) {
      parsed.reply = parsed.reply
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/#{1,6}\s/g, "")
        .replace(/^\s*[\d]+\.\s/gm, "")
        .replace(/^\s*[-*]\s/gm, "")
        .trim();
    }

    await Message.create({ userId, role: "ai", text: parsed.reply });

    const [images, videos] = await Promise.all([
      isImageRequest ? searchGoogleImages(searchTerm) : Promise.resolve([]),
      isVideoRequest ? searchPexelsVideos(searchTerm) : Promise.resolve([])
    ]);

    console.log("✅ Reply:", parsed.reply?.slice(0, 60));
    console.log("🖼 Images fetched:", images.length);
    console.log("🎬 Videos fetched:", videos.length);

    return res.json({ reply: parsed.reply, images, videos, mirrorTalk: mirrorTalkNeeded });

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