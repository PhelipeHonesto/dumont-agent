/**
 * Channel config + autonomy rule schemas.
 * Per spec: communication-layer.md sections 2.2, 2.4.
 */

import { z } from "zod";
import { MessageChannel, MessageIntent } from "./message.js";

export const AutonomyRuleSchema = z.object({
  channel: MessageChannel,
  intent: MessageIntent,
  recipientType: z.enum(["client", "operator"]),
  autoSendEnabled: z.boolean(),
  autoSendAfter: z.number().int().nonnegative(),
  currentApprovals: z.number().int().nonnegative(),
  maxDelaySeconds: z.number().int().nonnegative(),
});
export type AutonomyRule = z.infer<typeof AutonomyRuleSchema>;

export const ChannelConfigSchema = z.object({
  channel: MessageChannel,
  enabled: z.boolean(),
  rateLimitPerHour: z.number().int().positive(),
  currentHourCount: z.number().int().nonnegative(),
  currentHourStart: z.string().datetime().nullable(),
});
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
