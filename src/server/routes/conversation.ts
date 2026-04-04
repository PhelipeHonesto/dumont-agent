/**
 * POST /api/dumont/respond — direct REST endpoint for curl testing.
 */

import { Router } from "express";
import { processConversation } from "../dumont-brain.js";

export const conversationRouter = Router();

conversationRouter.post("/api/dumont/respond", (req, res) => {
  const { call_id, transcript, last_utterance, extracted } = req.body ?? {};
  if (!call_id) { res.status(400).json({ error: "call_id required" }); return; }
  res.json(processConversation({ call_id, transcript: transcript ?? "", last_utterance: last_utterance ?? "", extracted: extracted ?? null }));
});
