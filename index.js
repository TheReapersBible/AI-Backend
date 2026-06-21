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
    excuses: String,
    fears: String,
    habits: String,
    timeUse: String,
    whyItMatters: String,
    affirmations: [String],
    active: { type: Boolean, default: false },
    stage: { type: Number, default: 0 },
    imageUrl: String
  },
  winScore: { type: Number, default: 5 },
  lastAffirmationReminder: { type: Date, default: null },
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
          voice: {
            languageCode: "en-US",
            name: "en-US-Neural2-D"
          },
          audioConfig: {
            audioEncoding: "MP3",
            speakingRate: 0.92,
            pitch: -4.0
          }
        })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.log("GOOGLE TTS ERROR:", err);
      return res.status(500).json({ error: "Voice generation failed" });
    }

    const data = await response.json();
    const audioBuffer = Buffer.from(data.audioContent, "base64");

    res.set("Content-Type", "audio/mpeg");
    res.send(audioBuffer);

  } catch (err) {
    console.log("SPEAK ROUTE ERROR:", err);
    res.status(500).json({ error: "Voice generation failed" });
  }
});

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
    lower.includes("update my alter ego") ||
    lower.includes("start my alter ego")
  );
}

/* ========================
   AFFIRMATION REQUEST DETECTOR
======================== */
function isAffirmationRequest(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("affirmation") ||
    (lower.includes("write down") && lower.includes("believe")) ||
    lower.includes("visualize")
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
    "i didn't", "i resisted", "i said no", "i affirmed", "i visualized"
  ];

  const negativeSignals = [
    "i wasted", "i spent", "i skipped", "i didn't work out",
    "i slept in", "i gave up", "i failed", "i couldn't",
    "i procrastinated", "i was lazy", "i blew it"
  ];

  positiveSignals.forEach(s => { if (lower.includes(s)) score += 1; });
  negativeSignals.forEach(s => { if (lower.includes(s)) score -= 1; });

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
   ALTER EGO QUESTION FLOW
   Designed to actually connect emotionally,
   not just collect data points
======================== */
const alterEgoQuestions = [
  {
    question: "Before we name anything — tell me, who were you before life started talking you out of things? What did that version of you actually want?",
    field: "whyItMatters"
  },
  {
    question: "Alright. Now give that person a name. Not a nickname — the name of who you're becoming.",
    field: "name"
  },
  {
    question: "Real talk, what's the excuse you reach for the most when you don't do what you told yourself you'd do? I'm not judging, I just need to know what we're working against.",
    field: "excuses"
  },
  {
    question: "Look back at your last 7 days honestly. How much of that time actually moved you toward what you just told me you want, versus just... passing through?",
    field: "timeUse"
  },
  {
    question: "What's the fear that shows up right when you're about to do the thing? Name it. Fears lose power when you say them out loud.",
    field: "fears"
  },
  {
    question: "What's one habit you already know is working against you, that you keep doing anyway? Just one. The real one.",
    field: "habits"
  },
  {
    question: "Last thing — if this version of you succeeds, what does that actually prove? Not to the world. To you.",
    field: "mission"
  },
  {
    question: "Now give me 3 affirmations for this person — say them like they're already true right now, not someday. Example: 'I am disciplined. I follow through. I am becoming who I said I'd be.'",
    field: "affirmations"
  }
];

function getAlterEgoStage(stage) {
  return alterEgoQuestions[stage] || null;
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

    let user = await User.findOne({ userId });
    if (!user) {
      user = await User.create({ userId, goals: [], traits: [], winScore: 5 });
    }

    await Message.create({ userId, role: "user", text: message });

    const recentMessages = await Message.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    const history = recentMessages.reverse().map(m => m.text);

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

    const { isImageRequest, isVideoRequest, searchTerm } = detectMediaRequest(message);
    const mirrorTalkNeeded = needsMirrorTalk(message);
    const alterEgoRequest = isAlterEgoRequest(message);
    const affirmationRequest = isAffirmationRequest(message);
    const winScore = calculateWinScore(message, user.goals);

    user.winScore = Math.round((user.winScore + winScore) / 2);

    /* ========================
       ALTER EGO FLOW STATE MACHINE
    ======================== */
    let inAlterEgoFlow = false;

    if (alterEgoRequest && (!user.alterEgo || user.alterEgo.stage === undefined)) {
      user.alterEgo = { stage: 0, active: false, affirmations: [] };
    }

    if (user.alterEgo && user.alterEgo.stage > 0 && user.alterEgo.stage < alterEgoQuestions.length && !alterEgoRequest) {
      inAlterEgoFlow = true;
    }

    if (alterEgoRequest || inAlterEgoFlow) {
      const stage = user.alterEgo.stage || 0;

      // Save the answer to the question they just answered
      if (stage > 0) {
        const prevQ = alterEgoQuestions[stage - 1];
        if (prevQ.field === "affirmations") {
          user.alterEgo.affirmations = message.split(/[.!\n]/).map(s => s.trim()).filter(Boolean);
        } else if (prevQ.field) {
          user.alterEgo[prevQ.field] = message;
        }
      }

      const nextStage = alterEgoRequest && stage === 0 ? 0 : stage + 1;
      const nextQ = getAlterEgoStage(nextStage);

      if (nextQ) {
        user.alterEgo.stage = nextStage + 1;
        await user.save();

        // Use the AI itself to deliver the question warmly and react to what they just said
        const flowPrompt = `
You are a warm, wise, emotionally present life coach with deep Southern soul — think Bernie Mac if he sat you down for real talk, not jokes.

The user is going through a guided self-discovery process to build their "Alter Ego" — the version of themselves they're becoming.

${stage > 0 ? `They just answered: "${message}"` : "They just asked to start this process."}

Your job:
${stage > 0 ? "First, genuinely react to what they just said — one short sentence that shows you actually heard them, with empathy and warmth, not generic encouragement. Make them feel SEEN." : "Welcome them into this moment warmly, let them know this is real, not a form to fill out."}

Then ask them this exact next question, but in your own natural voice, keep the core meaning the same: "${nextQ.question}"

Rules:
- No lists, no markdown, no bullet points
- Talk like you're sitting across from them, not interviewing them
- Short. Real. A reaction plus a question. Nothing more.
- Never sound like a chatbot collecting form data
`;

        const flowCompletion = await client.chat.completions.create({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "system", content: flowPrompt }]
        });

        const flowReply = flowCompletion.choices[0].message.content.trim();

        await Message.create({ userId, role: "ai", text: flowReply });

        return res.json({
          reply: flowReply,
          images: [],
          videos: [],
          winScore,
          mirrorTalk: false,
          alterEgoActive: false,
          alterEgoFlow: true
        });
      } else {
        // Finished the flow — emotional reveal moment
        user.alterEgo.active = true;
        await user.save();

        const affirmationList = user.alterEgo.affirmations?.join(". ") || "I am becoming who I said I would be.";

        const revealPrompt = `
You are a warm, emotionally present Southern life coach. The user just finished building their Alter Ego through deep self-reflection.

Here's what they shared:
Who they were before life talked them out of things: ${user.alterEgo.whyItMatters}
Name: ${user.alterEgo.name}
Their excuse pattern: ${user.alterEgo.excuses}
How they've been spending time: ${user.alterEgo.timeUse}
Their fear: ${user.alterEgo.fears}
Their habit working against them: ${user.alterEgo.habits}
What success would prove to them: ${user.alterEgo.mission}
Their affirmations: ${affirmationList}

Write a genuine, emotionally resonant reveal moment. Reflect back who they are becoming using their own words and story — make them feel like you actually listened to everything, not just collected data.
Then tell them clearly: write these affirmations down somewhere they'll see daily, say them OUT LOUD every morning (not just in their head), then close their eyes for 60 seconds and actually feel what it's like to already be that person.
End by telling them you're holding them to this now, with warmth, not pressure.

Rules: no lists, no markdown, talk like a real person, 4-6 sentences max, hit them emotionally.
`;

        const revealCompletion = await client.chat.completions.create({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "system", content: revealPrompt }]
        });

        const summary = revealCompletion.choices[0].message.content.trim();

        await Message.create({ userId, role: "ai", text: summary });

        const imageQuery = `${user.alterEgo.name} ${user.alterEgo.mission}`.slice(0, 80);
        const images = await searchGoogleImages(imageQuery);
        if (images.length > 0) {
          user.alterEgo.imageUrl = images[0].url;
          await user.save();
        }

        return res.json({
          reply: summary,
          images,
          videos: [],
          winScore,
          mirrorTalk: false,
          alterEgoActive: true,
          alterEgoFlow: false,
          alterEgoReveal: true
        });
      }
    }

    console.log("🔍 Media detected:", { isImageRequest, isVideoRequest, searchTerm });
    console.log("🪞 Mirror talk needed:", mirrorTalkNeeded);
    console.log("🏆 WIN Score:", winScore);

    await user.save();

    let systemPrompt = `
You are a Southern, Bernie Mac energy life coach — real, funny, deeply wise, talks like a person texting their boy who genuinely cares about them.

HARD RULES — NEVER break these:
- NEVER use numbered lists or bullet points. Ever.
- NEVER use bold text, asterisks, or markdown formatting
- NEVER start with "Here are", "Here's", "Sure!", "Of course!", "Great question!"
- Short punchy sentences, one or two at a time, not paragraphs
- Curse occasionally — damn, hell, man, bruh — keep it real
- No corporate speak, no therapy speak, no robot speak

EMOTIONAL CONNECTION — this matters as much as advice:
- Actually listen to what they said before responding with advice — react to the person first, the problem second
- If they're sharing something vulnerable, sit with it for a beat before pivoting to action
- Use their own words and specifics back to them so they know you're tracking their actual life, not giving generic responses
- Warmth and humor together — never choose just one

ADVICE QUALITY — this is critical:
- Don't give generic, surface-level advice anyone could get from a search engine
- Give SPECIFIC, actionable advice tailored to exactly what they said — name real tactics, real numbers, real steps when relevant
- Think like someone who actually built something real, not a textbook
- If they ask about business, money, fitness, relationships — go deep, give them something they haven't already heard a thousand times
- Back up advice with the "why" briefly, woven into the sentence naturally
- If a topic deserves more than a one liner, give them 3-4 sentences of real substance, still conversational, still no lists

AFFIRMATIONS AND VISUALIZATION:
- Naturally bring up writing down affirmations and saying them out loud daily when it fits, especially if they seem to be struggling or losing motivation
- Remind them that visualization isn't woo-woo, it's mental rehearsal — top performers in every field use it
- Don't force this into every message, only when it actually fits what they're talking about

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
Why this matters to them deep down: ${user.alterEgo.whyItMatters}
Mission: ${user.alterEgo.mission}
Affirmations: ${user.alterEgo.affirmations?.join(", ") || "none set"}
Known excuse pattern: ${user.alterEgo.excuses}
Known fear: ${user.alterEgo.fears}
Known bad habit: ${user.alterEgo.habits}
Speak to them AS someone who knows their full story. Call back to their excuses/fears/habits and affirmations when relevant — and remember WHY this matters to them, not just what they said. Push them to embody who they're becoming, with real warmth.
`;
    }

    if (mirrorTalkNeeded) {
      systemPrompt += `
MIRROR TALK MODE:
The user seems lost, stuck, or doubting themselves.
Be funny but honest. Call out what they said and tie it back to their goals.
If they have an alter ego with known excuses/fears/habits, call those out specifically by name.
Remind them of their affirmations if relevant — ask if they've actually been saying them.
But underneath the humor, make sure they feel like you actually care, not just clowning them.
One or two sentences max. Hit hard, with love, and move on.
`;
    }

    if (affirmationRequest) {
      systemPrompt += `
The user is asking about affirmations or visualization specifically.
Explain clearly: write affirmations down on paper or notes app, read them out loud every single day — out loud matters, not just reading silently — then spend a minute visualizing it as already true, feeling it in your body.
If they have an alter ego with saved affirmations, reference those specific ones.
`;
    }

    systemPrompt += `
NON NEGOTIABLE RULES:
- If the user asked for a photo or video just say you got them and you're sending it — one sentence
- Do what they ask FIRST then add your personality
- Always tie feedback back to their stated goals when relevant
- NEVER use lists or formatting of any kind

Return STRICT JSON ONLY, no markdown, no backticks, no extra text outside the JSON:
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