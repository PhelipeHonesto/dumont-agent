/**
 * POST /api/dumont/respond — direct REST endpoint for curl testing.
 * Authenticated via DUMONT_API_KEY or VAPI_SECRET Bearer token.
 */

import { Router, type Request, type Response } from "express";
import { processConversation } from "../dumont-brain.js";

export const conversationRouter = Router();

const DUMONT_API_KEY = process.env.DUMONT_API_KEY;
const VAPI_SECRET = process.env.VAPI_SECRET;
const IS_PROD = process.env.NODE_ENV === "production";

function checkConversationAuth(req: Request, res: Response): boolean {
  // In production, require auth. No exceptions.
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token && (token === DUMONT_API_KEY || token === VAPI_SECRET)) return true;

  if (!DUMONT_API_KEY && !VAPI_SECRET) {
    if (IS_PROD) {
      res.status(401).json({ error: "Authentication required in production. Set DUMONT_API_KEY or VAPI_SECRET." });
      return false;
    }
    return true; // Dev only — allow without keys
  }

  res.status(401).json({ error: "unauthorized" });
  return false;
}

conversationRouter.post("/api/dumont/respond", (req: Request, res: Response) => {
  if (!checkConversationAuth(req, res)) return;
  const { call_id, transcript, last_utterance, extracted } = req.body ?? {};
  if (!call_id) { res.status(400).json({ error: "call_id required" }); return; }
  res.json(processConversation({ call_id, transcript: transcript ?? "", last_utterance: last_utterance ?? "", extracted: extracted ?? null }));
});
