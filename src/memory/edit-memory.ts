/**
 * Edit Memory — learns the broker's voice from past corrections.
 * Per spec: communication-layer.md FR-10, section 2.6.
 * Queries MessageStore for edited drafts. No separate persistence.
 */

import type { MessageStore } from "./message-store.js";
import type { MessageIntent, MessageChannel } from "../schemas/message.js";

/** A single edit pattern: what Dumont wrote vs what the broker sent. */
export interface EditPattern {
  dumontWrote: string;
  brokerChangedTo: string;
  wordsChanged: number;
  context: string;
}

/**
 * Get recent edit patterns for a specific intent + channel combination.
 * Returns the broker's corrections sorted by most recent first.
 *
 * @param store - MessageStore to query.
 * @param intent - Message intent filter (e.g. "follow_up").
 * @param channel - Channel filter (e.g. "email").
 * @param limit - Max patterns to return (default 10, caps token budget).
 * @returns Array of edit patterns, most recent first.
 */
export function getEditHistory(
  store: MessageStore,
  intent: MessageIntent,
  channel: MessageChannel,
  limit: number = 10,
): EditPattern[] {
  const all = store.getAll()
    .filter((m) =>
      m.draftedBy === "dumont" &&
      m.direction === "outbound" &&
      m.intent === intent &&
      m.channel === channel &&
      m.editDistance !== null &&
      m.editDistance > 0 &&
      m.originalDraft !== null,
    )
    .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))
    .slice(0, limit);

  return all.map((m) => ({
    dumontWrote: m.originalDraft!,
    brokerChangedTo: m.body,
    wordsChanged: m.editDistance!,
    context: `${m.intent} / ${m.channel}`,
  }));
}

/**
 * Build the style-learning section for the respond system prompt.
 * Injects edit examples when available, omits the section on cold start.
 *
 * @param store - MessageStore to query.
 * @param intent - Message intent.
 * @param channel - Channel.
 * @returns Style learning prompt section, or empty string if no history.
 */
export function buildEditMemoryPromptSection(
  store: MessageStore,
  intent: MessageIntent,
  channel: MessageChannel,
): string {
  const history = getEditHistory(store, intent, channel);
  if (history.length === 0) return "";

  let section = "\n\n--- STYLE LEARNING ---\n";
  section += "Below are your recent drafts of this type that the broker edited before sending. ";
  section += "Study the differences and write in the broker's voice.\n\n";

  for (const ex of history) {
    section += `YOUR DRAFT: ${ex.dumontWrote}\n`;
    section += `BROKER SENT: ${ex.brokerChangedTo}\n`;
    section += "---\n";
  }

  return section;
}
