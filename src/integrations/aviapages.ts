/**
 * Aviapages API Integration — price calculator, flight calculator, directories.
 *
 * Endpoints per spec:
 * - POST /price_calculator/  → charter cost estimate
 * - POST /flight_calculator/ → flight time + route + fuel
 * - GET  /aircraft/{id}      → aircraft specs
 *
 * HTTP calls are stubbed for now — the full request/response flow is built
 * so that real API integration only requires filling in fetch bodies.
 * Tests inject a mock via the `fetchFn` option.
 */

export interface AviapagesConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface PriceEstimateParams {
  departure: string;   // ICAO
  arrival: string;     // ICAO
  aircraftType?: string;
  date: string;        // ISO date
  pax: number;
}

export interface PriceEstimateResult {
  low: number;
  high: number;
  flightTime: number;  // minutes
  fuelBurn: number;    // gallons
}

export interface FlightCalcParams {
  departure: string;
  arrival: string;
  aircraftType: string;
}

export interface FlightCalcResult {
  flightTime: number;  // minutes
  distance: number;    // nm
  fuelBurn: number;    // gallons
}

/**
 * Function type matching the subset of fetch we need.
 * Inject a mock in tests; production uses global fetch.
 */
export type FetchFn = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export class AviapagesClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(config: AviapagesConfig, fetchFn?: FetchFn) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://dir.aviapages.com/api";
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  }

  /**
   * Get a charter price estimate from the Aviapages Price Calculator API.
   * @param params - Departure/arrival ICAO, aircraft type, date, pax count.
   * @returns Price range with flight time and fuel burn, or null on API failure.
   */
  async getPriceEstimate(params: PriceEstimateParams): Promise<PriceEstimateResult | null> {
    const url = `${this.baseUrl}/price_calculator/`;
    try {
      const resp = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Authorization": `Token ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          departure: params.departure,
          arrival: params.arrival,
          aircraft_type: params.aircraftType ?? undefined,
          date: params.date,
          pax: params.pax,
        }),
      });

      if (!resp.ok) return null;

      const data = await resp.json() as Record<string, unknown>;

      // Map Aviapages response to our interface
      return {
        low: Number(data["price_low"] ?? data["low"] ?? 0),
        high: Number(data["price_high"] ?? data["high"] ?? 0),
        flightTime: Number(data["flight_time"] ?? data["flightTime"] ?? 0),
        fuelBurn: Number(data["fuel_burn"] ?? data["fuelBurn"] ?? 0),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get flight time, distance, and fuel burn from the Aviapages Flight Calculator API.
   * @param params - Departure/arrival ICAO and aircraft type.
   * @returns Flight calculation result, or null on API failure.
   */
  async getFlightCalculation(params: FlightCalcParams): Promise<FlightCalcResult | null> {
    const url = `${this.baseUrl}/flight_calculator/`;
    try {
      const resp = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Authorization": `Token ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          departure: params.departure,
          arrival: params.arrival,
          aircraft_type: params.aircraftType,
        }),
      });

      if (!resp.ok) return null;

      const data = await resp.json() as Record<string, unknown>;

      return {
        flightTime: Number(data["flight_time"] ?? data["flightTime"] ?? 0),
        distance: Number(data["distance"] ?? 0),
        fuelBurn: Number(data["fuel_burn"] ?? data["fuelBurn"] ?? 0),
      };
    } catch {
      return null;
    }
  }
}
