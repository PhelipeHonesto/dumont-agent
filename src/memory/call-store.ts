/**
 * Call Store — JSON file-backed persistence for call records.
 * Same pattern as DealStore and MessageStore.
 * Per spec: communication-layer.md FR-5.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Call } from "../schemas/call.js";
import { CallSchema } from "../schemas/call.js";

const DEFAULT_PATH = "./data/calls.json";

export class CallStore {
  private calls: Call[] = [];
  private readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
    this.load();
  }

  private load(): void {
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf-8"));
        this.calls = Array.isArray(raw)
          ? raw.filter((c) => CallSchema.safeParse(c).success)
          : [];
      } catch {
        this.calls = [];
      }
    }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.calls, null, 2));
  }

  /** Persist a call record. */
  saveCall(call: Call): void {
    this.calls.push(call);
    this.save();
  }

  /** Get all calls for a deal. */
  getByDealId(dealId: string): Call[] {
    return this.calls.filter((c) => c.dealId === dealId);
  }

  /** Get a single call by ID. */
  getById(callId: string): Call | null {
    return this.calls.find((c) => c.callId === callId) ?? null;
  }

  /** Total call count. */
  get count(): number {
    return this.calls.length;
  }
}
