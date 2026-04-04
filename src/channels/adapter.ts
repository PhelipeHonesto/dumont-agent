/**
 * ChannelAdapter interface — the contract every channel must implement.
 * Adapters are dumb pipes: normalize inbound, deliver outbound.
 * Per spec: communication-layer.md FR-3.
 */

import type { Message, MessageChannel } from "../schemas/message.js";

export interface DeliveryResult {
  success: boolean;
  platformMessageId: string | null;
  error: string | null;
}

export interface ChannelAdapter {
  /** Which channel this adapter handles. */
  readonly channel: MessageChannel;

  /**
   * Normalize a platform-specific inbound payload into a Message.
   * @param rawPayload - The raw webhook/event payload from the platform.
   * @returns A normalized Message object.
   */
  receive(rawPayload: unknown): Message;

  /**
   * Deliver an outbound Message via the platform's API.
   * @param message - The Message to send.
   * @returns Delivery result with platform message ID or error.
   */
  deliver(message: Message): Promise<DeliveryResult>;

  /** Whether this channel supports real-time streaming (voice, WebSocket). */
  supportsRealtime(): boolean;
}
