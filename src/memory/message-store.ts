/**
 * Message Store — JSON file-backed persistence for all messages.
 * Same pattern as DealStore. Used by thread matcher for lookups.
 * Per spec: communication-layer.md FR-8 (Data Capture).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Message } from "../schemas/message.js";
import { MessageSchema } from "../schemas/message.js";

const DEFAULT_PATH = "./data/messages.json";

export class MessageStore {
  private messages: Message[] = [];
  private readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
    this.load();
  }

  private load(): void {
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf-8"));
        this.messages = Array.isArray(raw)
          ? raw.filter((m) => MessageSchema.safeParse(m).success)
          : [];
      } catch {
        this.messages = [];
      }
    }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.messages, null, 2));
  }

  /** Persist a message. */
  saveMessage(message: Message): void {
    this.messages.push(message);
    this.save();
  }

  /** Get all messages for a deal. */
  getByDealId(dealId: string): Message[] {
    return this.messages.filter((m) => m.dealId === dealId);
  }

  /** Get a single message by its ID. */
  getByMessageId(id: string): Message | null {
    return this.messages.find((m) => m.id === id) ?? null;
  }

  /** Get messages by sender contact (phone or email). */
  getByContact(contact: string, limit?: number): Message[] {
    const needle = contact.toLowerCase();
    const results = this.messages.filter(
      (m) => m.from.toLowerCase() === needle || m.from.toLowerCase().includes(needle),
    );
    return limit ? results.slice(-limit) : results;
  }

  /** Get all messages (for edit memory queries). */
  getAll(): Message[] {
    return [...this.messages];
  }

  /** Total message count. */
  get count(): number {
    return this.messages.length;
  }
}
