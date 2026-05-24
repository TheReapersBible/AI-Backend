import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  userId: String,
  message: String,
  images: [String],
  videos: [String],
  reply: String,
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Message", messageSchema);