/**
 * Dumont Agent — Express server.
 * Voice AI via Vapi /chat/completions endpoint.
 * Port 3001.
 */

import express from "express";
import cors from "cors";
import { conversationRouter } from "./routes/conversation.js";
import { healthRouter } from "./routes/health.js";
import { vapiRouter } from "./routes/vapi-llm.js";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3001", 10);

app.use(cors());
app.use(express.json());

app.use(conversationRouter);
app.use(healthRouter);
app.use(vapiRouter);

app.listen(PORT, () => {
  console.log(`[dumont] Server running on port ${PORT}`);
});

export { app };
