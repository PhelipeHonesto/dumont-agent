/**
 * Aircraft Listing — marketplace listing from AvBuyer, Controller, Trade-A-Plane.
 *
 * Tracks active listings, price reductions, delistings, and confirmed sales
 * (cross-referenced with FAA registry ownership changes).
 *
 * All money fields are integer cents. price_history_json stores a JSON array
 * of {price_cents, date} entries for tracking price reductions over time.
 */

import { z } from "zod";

export const ListingSource = z.enum(["avbuyer", "controller", "trade-a-plane"]);
export type ListingSource = z.infer<typeof ListingSource>;

export const ListingStatus = z.enum(["active", "reduced", "delisted", "sold"]);
export type ListingStatus = z.infer<typeof ListingStatus>;

export const PriceHistoryEntrySchema = z.object({
  priceCents: z.number().int(),
  date: z.string(),
});
export type PriceHistoryEntry = z.infer<typeof PriceHistoryEntrySchema>;

export const AircraftListingSchema = z.object({
  tailNumber: z.string(),
  source: ListingSource,
  listingUrl: z.string().nullable(),
  askingPriceCents: z.number().int().nullable(),
  currency: z.string().default("USD"),
  aircraftType: z.string().nullable(),
  year: z.number().int().nullable(),
  description: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  priceHistory: z.array(PriceHistoryEntrySchema).default([]),
  status: ListingStatus.default("active"),
  daysOnMarket: z.number().int().nonnegative().default(0),
});
export type AircraftListing = z.infer<typeof AircraftListingSchema>;
