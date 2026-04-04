/**
 * Thread Matcher — matches inbound messages to existing deals.
 * Per spec: communication-layer.md FR-2, FR-7, section 2.1 step 1.
 *
 * Strategy (in priority order):
 * 1. responseToId chain (email In-Reply-To → find deal by message ID)
 * 2. Phone number match to active deal
 * 3. Email address match + recency (48 hours)
 * 4. threadId match (email thread, conversation SID)
 * Most recent deal wins ties.
 */

import type { Message } from "../schemas/message.js";
import type { Conversation } from "../schemas/conversation.js";
import type { DealContext } from "../schemas/deal-context.js";

/** Active deal with its conversation, managed by the router. */
export interface ActiveDeal {
  deal: DealContext;
  conversation: Conversation;
}

const TERMINAL_STAGES = new Set(["closed", "failed"]);
const RECENCY_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Match an inbound message to an existing active deal.
 * Returns the matched ActiveDeal or null if no match found.
 *
 * @param msg - The inbound message to match.
 * @param activeDeals - All currently tracked deals with conversations.
 * @returns The best-matching deal, or null for a new deal.
 */
export function matchThread(
  msg: Message,
  activeDeals: ActiveDeal[],
): ActiveDeal | null {
  // Filter to non-terminal deals for matching
  const live = activeDeals.filter((d) => !TERMINAL_STAGES.has(d.deal.stage));

  // Strategy 1: responseToId chain — most precise
  if (msg.responseToId) {
    const match = findByMessageId(msg.responseToId, activeDeals);
    if (match) return match;
  }

  // Strategy 2: Phone number match
  const byPhone = findByContact(msg.from, live);
  if (byPhone) return byPhone;

  // Strategy 3: Email match with recency window
  const byEmail = findByContactWithRecency(msg.from, live, RECENCY_WINDOW_MS);
  if (byEmail) return byEmail;

  // Strategy 4: threadId match
  if (msg.threadId) {
    const byThread = findByThreadId(msg.threadId, activeDeals);
    if (byThread) return byThread;
  }

  return null;
}

// ── Strategy implementations ─────────────────────────────────────────────

/**
 * Find a deal by searching all conversations for a message with the given ID.
 * Searches ALL deals (including closed) for reply chain integrity.
 */
function findByMessageId(messageId: string, deals: ActiveDeal[]): ActiveDeal | null {
  for (const ad of deals) {
    if (ad.conversation.messages.some((m) => m.id === messageId)) {
      // If the matched deal is closed, return null (router will create new deal)
      if (TERMINAL_STAGES.has(ad.deal.stage)) return null;
      return ad;
    }
  }
  return null;
}

/**
 * Find the most recently updated deal where the contact matches.
 * Contact can be a phone number or email.
 */
function findByContact(contact: string, deals: ActiveDeal[]): ActiveDeal | null {
  const needle = contact.toLowerCase();
  const matches = deals.filter((ad) => {
    const clientContact = ad.deal.client.contact?.toLowerCase() ?? "";
    const operatorPhone = ad.deal.sourcing.selectedOperator?.phone?.toLowerCase() ?? "";
    return (
      (clientContact && (clientContact === needle || clientContact.includes(needle) || needle.includes(clientContact))) ||
      (operatorPhone && (operatorPhone === needle || operatorPhone.includes(needle)))
    );
  });

  if (matches.length === 0) return null;
  // Most recent deal wins
  return mostRecent(matches);
}

/**
 * Find by contact with a recency window — only matches deals updated within N ms.
 */
function findByContactWithRecency(
  contact: string,
  deals: ActiveDeal[],
  windowMs: number,
): ActiveDeal | null {
  const now = Date.now();
  const recent = deals.filter((ad) => {
    const updated = new Date(ad.deal.updatedAt).getTime();
    return now - updated < windowMs;
  });
  return findByContact(contact, recent);
}

/**
 * Find a deal whose conversation contains messages with a matching threadId.
 */
function findByThreadId(threadId: string, deals: ActiveDeal[]): ActiveDeal | null {
  const matches = deals.filter((ad) =>
    ad.conversation.messages.some((m) => m.threadId === threadId),
  );
  if (matches.length === 0) return null;
  const live = matches.filter((ad) => !TERMINAL_STAGES.has(ad.deal.stage));
  return live.length > 0 ? mostRecent(live) : null;
}

/** Pick the most recently updated deal from a list. */
function mostRecent(deals: ActiveDeal[]): ActiveDeal {
  return deals.sort((a, b) => b.deal.updatedAt.localeCompare(a.deal.updatedAt))[0]!;
}
