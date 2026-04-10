import { z } from "zod";

export const FaaAircraftSchema = z.object({
  tailNumber: z.string(),
  serialNumber: z.string().nullable(),
  mfrModelCode: z.string().nullable(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  commonName: z.string().nullable(),
  aircraftClass: z.string().nullable(),
  yearManufactured: z.number().nullable(),
  engineType: z.string().nullable(),
  numEngines: z.number().nullable(),
  numSeats: z.number().nullable(),
  ownerName: z.string().nullable(),
  ownerCity: z.string().nullable(),
  ownerState: z.string().nullable(),
  registrantType: z.string().nullable(),
  certificateHolder: z.string().nullable(),
  certificateNumber: z.string().nullable(),
  status: z.string().default("active"),
});
export type FaaAircraft = z.infer<typeof FaaAircraftSchema>;

export const FaaOperatorSchema = z.object({
  certificateNumber: z.string(),
  name: z.string(),
  dbaName: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  phone: z.string().nullable(),
  aircraftCount: z.number().default(0),
  status: z.string().default("active"),
});
export type FaaOperator = z.infer<typeof FaaOperatorSchema>;

export const FaaAirportSchema = z.object({
  icaoCode: z.string(),
  iataCode: z.string().nullable(),
  faaId: z.string().nullable(),
  name: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().default("US"),
  latitude: z.number(),
  longitude: z.number(),
  elevationFt: z.number().nullable(),
  longestRunwayFt: z.number().nullable(),
  runwaySurface: z.string().nullable(),
  hasInstrumentApproach: z.boolean().default(false),
  fuelTypes: z.string().nullable(),
  towerControlled: z.boolean().default(false),
  status: z.string().default("active"),
});
export type FaaAirport = z.infer<typeof FaaAirportSchema>;
