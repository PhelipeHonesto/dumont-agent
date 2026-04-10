/**
 * Database Migrations — creates tables on startup, idempotently.
 *
 * Design decisions:
 * - All money fields are INTEGER cents (no floats, ever)
 * - Every money field has a companion currency TEXT column (default 'USD')
 * - Every table has schema_version for forward-compatible evolution
 * - deal_events is append-only (no UPDATE, no DELETE) — audit trail
 * - JSON columns for arrays/nested objects (topOperators, fleet, certs, dealHistory, etc.)
 */

import type Database from "better-sqlite3";

interface Migration {
  id: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "create_migrations_table",
    sql: `
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    id: 2,
    name: "create_deals",
    sql: `
      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sim', 'live')),
        schema_version INTEGER NOT NULL DEFAULT 1,

        -- Route
        route_departure TEXT NOT NULL,
        route_arrival TEXT NOT NULL,
        route_distance REAL NOT NULL DEFAULT 0,

        -- Pricing (INTEGER cents)
        estimate_low_cents INTEGER,
        estimate_high_cents INTEGER,
        operator_quote_cents INTEGER,
        osa_price_cents INTEGER,
        estimate_delta REAL,
        currency TEXT NOT NULL DEFAULT 'USD',

        -- Operator
        operator_name TEXT,
        operator_base TEXT,
        operator_response_time REAL,
        operator_conversion INTEGER NOT NULL DEFAULT 0,

        -- Aircraft
        aircraft_type TEXT,
        aircraft_class TEXT,

        -- Client
        client_name TEXT,
        client_contact TEXT,
        client_type TEXT NOT NULL DEFAULT 'new',
        client_budget_min_cents INTEGER,
        client_budget_max_cents INTEGER,
        client_conversion INTEGER NOT NULL DEFAULT 0,
        decision_time REAL,

        -- Outcome
        result TEXT NOT NULL,
        revenue_cents INTEGER,
        margin REAL,

        -- Timing
        total_deal_time REAL,
        day_of_week INTEGER NOT NULL DEFAULT 0,
        season TEXT NOT NULL DEFAULT 'off',

        -- Meta
        guardian_flags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_deals_route ON deals(route_departure, route_arrival);
      CREATE INDEX IF NOT EXISTS idx_deals_operator ON deals(operator_name);
      CREATE INDEX IF NOT EXISTS idx_deals_client ON deals(client_name, client_contact);
      CREATE INDEX IF NOT EXISTS idx_deals_timestamp ON deals(timestamp);
    `,
  },
  {
    id: 3,
    name: "create_route_intel",
    sql: `
      CREATE TABLE IF NOT EXISTS route_intel (
        route TEXT NOT NULL,
        aircraft_class TEXT NOT NULL,
        avg_price_30d_cents INTEGER,
        deal_count INTEGER NOT NULL DEFAULT 0,
        demand_trend TEXT NOT NULL DEFAULT 'stable',
        top_operators TEXT NOT NULL DEFAULT '[]',
        seasonal_factor REAL NOT NULL DEFAULT 1.0,
        avg_margin_delta REAL NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        schema_version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (route, aircraft_class)
      );
    `,
  },
  {
    id: 4,
    name: "create_operator_profiles",
    sql: `
      CREATE TABLE IF NOT EXISTS operator_profiles (
        name TEXT PRIMARY KEY,
        home_base TEXT NOT NULL DEFAULT '',
        certs TEXT NOT NULL DEFAULT '[]',
        fleet TEXT NOT NULL DEFAULT '[]',
        avg_response_time REAL NOT NULL DEFAULT 0,
        reliability_score REAL NOT NULL DEFAULT 0,
        pricing_delta REAL NOT NULL DEFAULT 0,
        payment_speed REAL NOT NULL DEFAULT 0,
        quote_to_book_rate REAL NOT NULL DEFAULT 0,
        cancel_rate REAL NOT NULL DEFAULT 0,
        deal_count INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
    `,
  },
  {
    id: 5,
    name: "create_client_profiles",
    sql: `
      CREATE TABLE IF NOT EXISTS client_profiles (
        email TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        deal_history TEXT NOT NULL DEFAULT '[]',
        avg_payment_time REAL NOT NULL DEFAULT 0,
        total_spend_cents INTEGER NOT NULL DEFAULT 0,
        trip_frequency REAL NOT NULL DEFAULT 0,
        preferred_aircraft_class TEXT,
        preferred_routes TEXT NOT NULL DEFAULT '[]',
        last_updated TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_client_profiles_name ON client_profiles(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_client_profiles_email ON client_profiles(email COLLATE NOCASE);
    `,
  },
  {
    id: 6,
    name: "create_validation_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS validation_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route TEXT NOT NULL,
        date TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sim', 'live')),
        lead_time_hours REAL NOT NULL DEFAULT 0,
        rli_at_quote TEXT NOT NULL DEFAULT 'low',
        dumont_physics_estimate_cents INTEGER,
        ghost_positioning_value REAL,
        operator_quoted_price_cents INTEGER,
        osa_client_price_cents INTEGER,
        realized_margin_pct REAL,
        rfqs_sent INTEGER NOT NULL DEFAULT 1,
        quotes_received INTEGER NOT NULL DEFAULT 0,
        operator_response_minutes REAL,
        client_decision_minutes REAL,
        outcome TEXT NOT NULL DEFAULT 'lost_other',
        fleet_resilience_used INTEGER NOT NULL DEFAULT 0,
        trip_completed INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL DEFAULT 'USD',
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_validation_ledger_route ON validation_ledger(route);
      CREATE INDEX IF NOT EXISTS idx_validation_ledger_date ON validation_ledger(date);
      CREATE INDEX IF NOT EXISTS idx_validation_ledger_outcome ON validation_ledger(outcome);
    `,
  },
  {
    id: 7,
    name: "create_deal_events",
    sql: `
      CREATE TABLE IF NOT EXISTS deal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_deal_events_deal_id ON deal_events(deal_id);
      CREATE INDEX IF NOT EXISTS idx_deal_events_type ON deal_events(event_type);
    `,
  },
  {
    id: 8,
    name: "create_messages",
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        deal_id TEXT,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT,
        from_name TEXT,
        subject TEXT,
        body TEXT NOT NULL,
        body_html TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        drafted_by TEXT,
        approved_by TEXT,
        edit_distance INTEGER,
        original_draft TEXT,
        received_at TEXT,
        drafted_at TEXT,
        approved_at TEXT,
        sent_at TEXT,
        response_to_id TEXT,
        response_time_ms REAL,
        thread_id TEXT,
        intent TEXT,
        parsed_data TEXT,
        confidence REAL,
        confidence_level TEXT,
        platform_message_id TEXT,
        platform_metadata TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_messages_deal_id ON messages(deal_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
    `,
  },
  {
    id: 9,
    name: "create_calls",
    sql: `
      CREATE TABLE IF NOT EXISTS calls (
        call_id TEXT PRIMARY KEY,
        deal_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        participants TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_sec REAL,
        transcript TEXT NOT NULL DEFAULT '[]',
        detected_entities TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        recording_url TEXT,
        recording_expires_at TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_calls_deal_id ON calls(deal_id);
    `,
  },
  {
    id: 10,
    name: "create_autonomy_rules",
    sql: `
      CREATE TABLE IF NOT EXISTS autonomy_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        intent TEXT NOT NULL,
        recipient_type TEXT NOT NULL,
        auto_send_enabled INTEGER NOT NULL DEFAULT 0,
        auto_send_after INTEGER NOT NULL DEFAULT 10,
        current_approvals INTEGER NOT NULL DEFAULT 0,
        max_delay_seconds INTEGER NOT NULL DEFAULT 30,
        schema_version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(channel, intent, recipient_type)
      );
    `,
  },
  {
    id: 11,
    name: "create_processed_webhooks",
    sql: `
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        idempotency_key TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    id: 12,
    name: "expand_validation_ledger",
    sql: `
      ALTER TABLE validation_ledger ADD COLUMN ghost_value_cents INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE validation_ledger ADD COLUMN ghost_description TEXT;
      ALTER TABLE validation_ledger ADD COLUMN rli_score REAL;
      ALTER TABLE validation_ledger ADD COLUMN trip_outcome TEXT NOT NULL DEFAULT 'completed';
      ALTER TABLE validation_ledger ADD COLUMN recovery_time_min REAL;
      ALTER TABLE validation_ledger ADD COLUMN route_page_views_7d INTEGER;
      ALTER TABLE validation_ledger ADD COLUMN options_presented_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN client_confirmed_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN operators_in_network INTEGER;
      ALTER TABLE validation_ledger ADD COLUMN operators_in_metro INTEGER;
      ALTER TABLE validation_ledger ADD COLUMN estimate_delta_percent REAL;
      ALTER TABLE validation_ledger ADD COLUMN operator_name TEXT;
      ALTER TABLE validation_ledger ADD COLUMN operator_base TEXT;
      ALTER TABLE validation_ledger ADD COLUMN operator_reliability_score REAL;
      ALTER TABLE validation_ledger ADD COLUMN revenue_cents INTEGER;
      ALTER TABLE validation_ledger ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE validation_ledger ADD COLUMN client_paid_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN operator_paid_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN float_window_hours REAL;
      ALTER TABLE validation_ledger ADD COLUMN created_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN updated_at TEXT;
    `,
  },
  {
    id: 13,
    name: "create_knowledge_graph",
    sql: `
      CREATE TABLE IF NOT EXISTS faa_aircraft (
        tail_number TEXT PRIMARY KEY,
        serial_number TEXT,
        mfr_model_code TEXT,
        manufacturer TEXT,
        model TEXT,
        common_name TEXT,
        aircraft_class TEXT,
        year_manufactured INTEGER,
        engine_type TEXT,
        num_engines INTEGER,
        num_seats INTEGER,
        owner_name TEXT,
        owner_city TEXT,
        owner_state TEXT,
        registrant_type TEXT,
        certificate_holder TEXT,
        certificate_number TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_faa_aircraft_class ON faa_aircraft(aircraft_class);
      CREATE INDEX IF NOT EXISTS idx_faa_aircraft_cert ON faa_aircraft(certificate_number);
      CREATE INDEX IF NOT EXISTS idx_faa_aircraft_model ON faa_aircraft(common_name);

      CREATE TABLE IF NOT EXISTS faa_operators (
        certificate_number TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dba_name TEXT,
        address TEXT,
        city TEXT,
        state TEXT,
        zip TEXT,
        phone TEXT,
        aircraft_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_faa_operators_state ON faa_operators(state);
      CREATE INDEX IF NOT EXISTS idx_faa_operators_name ON faa_operators(name);

      CREATE TABLE IF NOT EXISTS faa_airports (
        icao_code TEXT PRIMARY KEY,
        iata_code TEXT,
        faa_id TEXT,
        name TEXT NOT NULL,
        city TEXT,
        state TEXT,
        country TEXT DEFAULT 'US',
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        elevation_ft INTEGER,
        longest_runway_ft INTEGER,
        runway_surface TEXT,
        has_instrument_approach INTEGER DEFAULT 0,
        fuel_types TEXT,
        tower_controlled INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_faa_airports_state ON faa_airports(state);
      CREATE INDEX IF NOT EXISTS idx_faa_airports_coords ON faa_airports(latitude, longitude);
    `,
  },
  {
    id: 14,
    name: "create_adsb_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS adsb_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        icao_hex TEXT NOT NULL,
        tail_number TEXT,
        callsign TEXT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude_ft REAL,
        ground_speed_kts REAL,
        heading REAL,
        vertical_rate REAL,
        on_ground INTEGER NOT NULL DEFAULT 0,
        nearest_airport TEXT,
        timestamp INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_adsb_icao ON adsb_positions(icao_hex);
      CREATE INDEX IF NOT EXISTS idx_adsb_timestamp ON adsb_positions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_adsb_tail ON adsb_positions(tail_number);

      CREATE TABLE IF NOT EXISTS adsb_aircraft_state (
        icao_hex TEXT PRIMARY KEY,
        tail_number TEXT,
        operator_name TEXT,
        aircraft_type TEXT,
        aircraft_class TEXT,
        state TEXT NOT NULL DEFAULT 'unknown',
        latitude REAL,
        longitude REAL,
        nearest_airport TEXT,
        idle_since TEXT,
        idle_hours REAL DEFAULT 0,
        last_seen TEXT NOT NULL,
        last_leg_origin TEXT,
        last_leg_destination TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_adsb_state_class ON adsb_aircraft_state(aircraft_class);
      CREATE INDEX IF NOT EXISTS idx_adsb_state_state ON adsb_aircraft_state(state);
      CREATE INDEX IF NOT EXISTS idx_adsb_state_airport ON adsb_aircraft_state(nearest_airport);

      ALTER TABLE faa_aircraft ADD COLUMN icao_hex TEXT;
      CREATE INDEX IF NOT EXISTS idx_faa_aircraft_hex ON faa_aircraft(icao_hex);
    `,
  },
  {
    id: 15,
    name: "create_adsb_completed_legs",
    sql: `
      CREATE TABLE IF NOT EXISTS adsb_completed_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        icao_hex TEXT NOT NULL,
        tail_number TEXT,
        operator_name TEXT,
        aircraft_type TEXT,
        aircraft_class TEXT,
        origin_icao TEXT,
        destination_icao TEXT,
        departure_time TEXT NOT NULL,
        arrival_time TEXT NOT NULL,
        flight_time_min INTEGER,
        distance_nm REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_legs_tail ON adsb_completed_legs(tail_number);
      CREATE INDEX IF NOT EXISTS idx_legs_origin ON adsb_completed_legs(origin_icao);
      CREATE INDEX IF NOT EXISTS idx_legs_dest ON adsb_completed_legs(destination_icao);
      CREATE INDEX IF NOT EXISTS idx_legs_class ON adsb_completed_legs(aircraft_class);
      CREATE INDEX IF NOT EXISTS idx_legs_time ON adsb_completed_legs(departure_time);
    `,
  },
];

/**
 * Run all pending migrations. Idempotent — skips already-applied migrations.
 */
export function runMigrations(db: Database.Database): void {
  // Migration 1 creates the tracking table — always run it first
  db.exec(MIGRATIONS[0]!.sql);

  const applied = new Set(
    db.prepare("SELECT id FROM _migrations").all().map((r) => (r as { id: number }).id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec(migration.sql);
    db.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(
      migration.id,
      migration.name,
    );
  }
}
