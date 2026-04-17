-- Dumont Agent — PostgreSQL Schema (Supabase)
-- Converted from 30 SQLite migrations. All tables, indexes, seed data.
-- Run via: npm run db:migrate-pg

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Migration tracking ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2: deals ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('sim', 'live')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  route_departure TEXT NOT NULL,
  route_arrival TEXT NOT NULL,
  route_distance REAL NOT NULL DEFAULT 0,
  estimate_low_cents INTEGER,
  estimate_high_cents INTEGER,
  operator_quote_cents INTEGER,
  osa_price_cents INTEGER,
  estimate_delta REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  operator_name TEXT,
  operator_base TEXT,
  operator_response_time REAL,
  operator_conversion INTEGER NOT NULL DEFAULT 0,
  aircraft_type TEXT,
  aircraft_class TEXT,
  client_name TEXT,
  client_contact TEXT,
  client_type TEXT NOT NULL DEFAULT 'new',
  client_budget_min_cents INTEGER,
  client_budget_max_cents INTEGER,
  client_conversion INTEGER NOT NULL DEFAULT 0,
  decision_time REAL,
  result TEXT NOT NULL,
  revenue_cents INTEGER,
  margin REAL,
  total_deal_time REAL,
  day_of_week INTEGER NOT NULL DEFAULT 0,
  season TEXT NOT NULL DEFAULT 'off',
  guardian_flags JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_deals_route ON deals(route_departure, route_arrival);
CREATE INDEX IF NOT EXISTS idx_deals_operator ON deals(operator_name);
CREATE INDEX IF NOT EXISTS idx_deals_client ON deals(client_name, client_contact);
CREATE INDEX IF NOT EXISTS idx_deals_timestamp ON deals(timestamp);

-- ── 3: route_intel ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS route_intel (
  route TEXT NOT NULL,
  aircraft_class TEXT NOT NULL,
  avg_price_30d_cents INTEGER,
  deal_count INTEGER NOT NULL DEFAULT 0,
  demand_trend TEXT NOT NULL DEFAULT 'stable',
  top_operators JSONB NOT NULL DEFAULT '[]',
  seasonal_factor REAL NOT NULL DEFAULT 1.0,
  avg_margin_delta REAL NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (route, aircraft_class)
);

-- ── 4: operator_profiles ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS operator_profiles (
  name TEXT PRIMARY KEY,
  home_base TEXT NOT NULL DEFAULT '',
  certs JSONB NOT NULL DEFAULT '[]',
  fleet JSONB NOT NULL DEFAULT '[]',
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

-- ── 5: client_profiles ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_profiles (
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  deal_history JSONB NOT NULL DEFAULT '[]',
  avg_payment_time REAL NOT NULL DEFAULT 0,
  total_spend_cents INTEGER NOT NULL DEFAULT 0,
  trip_frequency REAL NOT NULL DEFAULT 0,
  preferred_aircraft_class TEXT,
  preferred_routes JSONB NOT NULL DEFAULT '[]',
  last_updated TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_client_profiles_name ON client_profiles(name);
CREATE INDEX IF NOT EXISTS idx_client_profiles_email ON client_profiles(email);

-- ── 6: validation_ledger ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS validation_ledger (
  id SERIAL PRIMARY KEY,
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
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- migration 12 additions
  ghost_value_cents INTEGER NOT NULL DEFAULT 0,
  ghost_description TEXT,
  rli_score REAL,
  trip_outcome TEXT NOT NULL DEFAULT 'completed',
  recovery_time_min REAL,
  route_page_views_7d INTEGER,
  options_presented_at TEXT,
  client_confirmed_at TEXT,
  operators_in_network INTEGER,
  operators_in_metro INTEGER,
  estimate_delta_percent REAL,
  operator_name TEXT,
  operator_base TEXT,
  operator_reliability_score REAL,
  revenue_cents INTEGER,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  client_paid_at TEXT,
  operator_paid_at TEXT,
  float_window_hours REAL,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_validation_ledger_route ON validation_ledger(route);
CREATE INDEX IF NOT EXISTS idx_validation_ledger_date ON validation_ledger(date);
CREATE INDEX IF NOT EXISTS idx_validation_ledger_outcome ON validation_ledger(outcome);

-- ── 7: deal_events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deal_events (
  id SERIAL PRIMARY KEY,
  deal_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_deal_events_deal_id ON deal_events(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_events_type ON deal_events(event_type);

-- ── 8: messages ─────────────────────────────────────────────────────────────

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
  attachments JSONB NOT NULL DEFAULT '[]',
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
  parsed_data JSONB,
  confidence REAL,
  confidence_level TEXT,
  platform_message_id TEXT,
  platform_metadata JSONB,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_messages_deal_id ON messages(deal_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);

-- ── 9: calls ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  participants JSONB NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_sec REAL,
  transcript JSONB NOT NULL DEFAULT '[]',
  detected_entities JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  recording_url TEXT,
  recording_expires_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_calls_deal_id ON calls(deal_id);

-- ── 10: autonomy_rules ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS autonomy_rules (
  id SERIAL PRIMARY KEY,
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

-- ── 11: processed_webhooks ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS processed_webhooks (
  idempotency_key TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 13: FAA registry ────────────────────────────────────────────────────────

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
  icao_hex TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_faa_aircraft_class ON faa_aircraft(aircraft_class);
CREATE INDEX IF NOT EXISTS idx_faa_aircraft_cert ON faa_aircraft(certificate_number);
CREATE INDEX IF NOT EXISTS idx_faa_aircraft_model ON faa_aircraft(common_name);
CREATE INDEX IF NOT EXISTS idx_faa_aircraft_hex ON faa_aircraft(icao_hex);

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
  argus_rating TEXT CHECK (argus_rating IS NULL OR argus_rating IN ('gold', 'gold_plus', 'platinum', 'platinum_elite')),
  wyvern_rating TEXT CHECK (wyvern_rating IS NULL OR wyvern_rating IN ('wingman')),
  is_bao_stage INTEGER CHECK (is_bao_stage IS NULL OR is_bao_stage IN (1, 2, 3)),
  safety_verified_at TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
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
  has_instrument_approach BOOLEAN DEFAULT FALSE,
  fuel_types TEXT,
  tower_controlled BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_faa_airports_state ON faa_airports(state);
CREATE INDEX IF NOT EXISTS idx_faa_airports_coords ON faa_airports(latitude, longitude);

-- ── 14: ADS-B tables ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS adsb_positions (
  id SERIAL PRIMARY KEY,
  icao_hex TEXT NOT NULL,
  tail_number TEXT,
  callsign TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  altitude_ft REAL,
  ground_speed_kts REAL,
  heading REAL,
  vertical_rate REAL,
  on_ground BOOLEAN NOT NULL DEFAULT FALSE,
  nearest_airport TEXT,
  timestamp BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
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
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adsb_state_class ON adsb_aircraft_state(aircraft_class);
CREATE INDEX IF NOT EXISTS idx_adsb_state_state ON adsb_aircraft_state(state);
CREATE INDEX IF NOT EXISTS idx_adsb_state_airport ON adsb_aircraft_state(nearest_airport);

-- ── 15: completed legs ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS adsb_completed_legs (
  id SERIAL PRIMARY KEY,
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
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_legs_tail ON adsb_completed_legs(tail_number);
CREATE INDEX IF NOT EXISTS idx_legs_origin ON adsb_completed_legs(origin_icao);
CREATE INDEX IF NOT EXISTS idx_legs_dest ON adsb_completed_legs(destination_icao);
CREATE INDEX IF NOT EXISTS idx_legs_class ON adsb_completed_legs(aircraft_class);
CREATE INDEX IF NOT EXISTS idx_legs_time ON adsb_completed_legs(departure_time);

-- ── 16: deal_outcomes ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deal_outcomes (
  id SERIAL PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  quoted_price_cents INTEGER NOT NULL,
  actual_price_cents INTEGER NOT NULL,
  client_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  operator_response_time_seconds INTEGER NOT NULL DEFAULT 0,
  aircraft_substituted BOOLEAN NOT NULL DEFAULT FALSE,
  substitution_details TEXT,
  reason_lost TEXT CHECK (reason_lost IS NULL OR reason_lost IN ('price', 'timing', 'aircraft', 'competitor', 'other')),
  dumont_confidence_at_quote REAL NOT NULL DEFAULT 0,
  price_error_pct REAL NOT NULL DEFAULT 0,
  operator_name TEXT NOT NULL,
  aircraft_class TEXT NOT NULL,
  route_origin TEXT NOT NULL,
  route_destination TEXT NOT NULL,
  lead_time_hours REAL NOT NULL DEFAULT 0,
  day_of_week INTEGER NOT NULL DEFAULT 0 CHECK (day_of_week >= 0 AND day_of_week <= 6),
  currency TEXT NOT NULL DEFAULT 'USD',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_outcomes_deal_id ON deal_outcomes(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_outcomes_operator ON deal_outcomes(operator_name);
CREATE INDEX IF NOT EXISTS idx_deal_outcomes_route ON deal_outcomes(route_origin, route_destination);
CREATE INDEX IF NOT EXISTS idx_deal_outcomes_class ON deal_outcomes(aircraft_class);

-- ── 17: faa_registry_changes ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS faa_registry_changes (
  id SERIAL PRIMARY KEY,
  tail_number TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('new', 'deregistered', 'ownership_change', 'field_change')),
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_faa_changes_tail ON faa_registry_changes(tail_number);
CREATE INDEX IF NOT EXISTS idx_faa_changes_type ON faa_registry_changes(change_type);
CREATE INDEX IF NOT EXISTS idx_faa_changes_date ON faa_registry_changes(detected_at);

-- ── 18: pipeline_runs ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id SERIAL PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  steps_completed INTEGER NOT NULL DEFAULT 0,
  failed_step TEXT,
  new_aircraft INTEGER NOT NULL DEFAULT 0,
  deregistered INTEGER NOT NULL DEFAULT 0,
  ownership_changes INTEGER NOT NULL DEFAULT 0,
  field_changes INTEGER NOT NULL DEFAULT 0,
  aircraft_classified INTEGER NOT NULL DEFAULT 0,
  ghost_candidates INTEGER NOT NULL DEFAULT 0,
  total_in_graph INTEGER NOT NULL DEFAULT 0,
  charter_tracked INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_date ON pipeline_runs(started_at);

-- ── 19: faa_docindex ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS faa_docindex (
  id SERIAL PRIMARY KEY,
  tail_number TEXT,
  collateral_type INTEGER NOT NULL,
  collateral_raw TEXT NOT NULL,
  party_name TEXT,
  doc_id TEXT,
  doc_type TEXT NOT NULL,
  receipt_date TEXT,
  processing_date TEXT,
  correction_date TEXT,
  correction_id TEXT,
  serial_id TEXT,
  faa_aircraft_match INTEGER NOT NULL DEFAULT 0,
  aircraft_class TEXT,
  owner_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(collateral_raw, doc_id, receipt_date, doc_type, serial_id)
);
CREATE INDEX IF NOT EXISTS idx_docindex_tail ON faa_docindex(tail_number);
CREATE INDEX IF NOT EXISTS idx_docindex_type ON faa_docindex(doc_type);
CREATE INDEX IF NOT EXISTS idx_docindex_date ON faa_docindex(receipt_date);
CREATE INDEX IF NOT EXISTS idx_docindex_serial ON faa_docindex(serial_id);
CREATE INDEX IF NOT EXISTS idx_docindex_collateral_type ON faa_docindex(collateral_type);

-- ── 20: pilot tables ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pilot_contacts (
  certificate_number TEXT PRIMARY KEY,
  first_middle_name TEXT,
  last_name TEXT,
  street1 TEXT,
  street2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  country TEXT,
  region TEXT,
  medical_class TEXT,
  medical_date TEXT,
  medical_expire_date TEXT,
  ratings JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pilot_contacts_state ON pilot_contacts(state);
CREATE INDEX IF NOT EXISTS idx_pilot_contacts_city_state ON pilot_contacts(city, state);
CREATE INDEX IF NOT EXISTS idx_pilot_contacts_last_name ON pilot_contacts(last_name);

CREATE TABLE IF NOT EXISTS pilot_aircraft_link (
  id SERIAL PRIMARY KEY,
  certificate_number TEXT NOT NULL REFERENCES pilot_contacts(certificate_number),
  tail_number TEXT NOT NULL,
  pilot_name TEXT NOT NULL,
  pilot_city TEXT,
  pilot_state TEXT,
  aircraft_base_icao TEXT,
  aircraft_base_city TEXT,
  aircraft_base_state TEXT,
  aircraft_class TEXT,
  operator_name TEXT,
  match_type TEXT NOT NULL DEFAULT 'city_state',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(certificate_number, tail_number)
);
CREATE INDEX IF NOT EXISTS idx_pal_tail ON pilot_aircraft_link(tail_number);
CREATE INDEX IF NOT EXISTS idx_pal_cert ON pilot_aircraft_link(certificate_number);
CREATE INDEX IF NOT EXISTS idx_pal_state ON pilot_aircraft_link(pilot_state);
CREATE INDEX IF NOT EXISTS idx_pal_base ON pilot_aircraft_link(aircraft_base_icao);

-- ── 21: aircraft_listings ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aircraft_listings (
  tail_number TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('avbuyer', 'controller', 'trade-a-plane')),
  listing_url TEXT,
  asking_price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  aircraft_type TEXT,
  year INTEGER,
  description TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  price_history_json JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reduced', 'delisted', 'sold')),
  days_on_market INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tail_number, source)
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON aircraft_listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_type ON aircraft_listings(aircraft_type);
CREATE INDEX IF NOT EXISTS idx_listings_price ON aircraft_listings(asking_price_cents);
CREATE INDEX IF NOT EXISTS idx_listings_first_seen ON aircraft_listings(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_days ON aircraft_listings(days_on_market);

-- ── 22: target tables ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS target_companies (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL UNIQUE,
  tail_numbers JSONB NOT NULL DEFAULT '[]',
  aircraft_classes JSONB NOT NULL DEFAULT '[]',
  fleet_size INTEGER NOT NULL DEFAULT 0,
  estimated_annual_trips INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_target_companies_fleet ON target_companies(fleet_size);
CREATE INDEX IF NOT EXISTS idx_target_companies_trips ON target_companies(estimated_annual_trips);

CREATE TABLE IF NOT EXISTS target_contacts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES target_companies(id),
  name TEXT,
  title TEXT,
  email TEXT,
  phone TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_target_contacts_company ON target_contacts(company_id);

-- ── 23: eval tables ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS eval_runs (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_title TEXT NOT NULL,
  departure TEXT,
  arrival TEXT,
  aircraft_class TEXT,
  estimate_low_cents INTEGER,
  estimate_high_cents INTEGER,
  estimate_median_cents INTEGER,
  osa_price_cents INTEGER,
  market_low_cents INTEGER,
  market_high_cents INTEGER,
  within_20_pct BOOLEAN NOT NULL DEFAULT FALSE,
  error_pct REAL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'skip', 'error')),
  error_message TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_run_id ON eval_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_scenario ON eval_runs(scenario_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_status ON eval_runs(status);

CREATE TABLE IF NOT EXISTS eval_run_summaries (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  total_scenarios INTEGER NOT NULL,
  scored_scenarios INTEGER NOT NULL,
  within_20_pct_count INTEGER NOT NULL,
  accuracy_pct REAL NOT NULL,
  mean_error_pct REAL,
  median_error_pct REAL,
  max_error_pct REAL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_eval_summaries_run ON eval_run_summaries(run_id);

-- ── 24: backfill_progress ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backfill_progress (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  legs_found INTEGER NOT NULL DEFAULT 0,
  charter_legs INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- ── 25: knowledge_graph ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_graph (
  icao_hex TEXT PRIMARY KEY,
  tail_number TEXT,
  owner_name TEXT,
  operator_name TEXT,
  manufacturer TEXT,
  model TEXT,
  common_name TEXT,
  aircraft_class TEXT,
  year_manufactured INTEGER,
  num_seats INTEGER,
  certificate_number TEXT,
  state TEXT,
  latitude REAL,
  longitude REAL,
  nearest_airport TEXT,
  idle_since TEXT,
  idle_hours REAL DEFAULT 0,
  last_seen TEXT,
  last_leg_origin TEXT,
  last_leg_dest TEXT,
  operator_argus TEXT,
  operator_wyvern TEXT,
  operator_safety_score INTEGER DEFAULT 0,
  -- Graph flags (populated by src/ingestion/update-graph.ts, Phase 6 Tier 3)
  is_charter_class INTEGER DEFAULT 0,
  is_near_network_airport INTEGER DEFAULT 0,
  is_ghost_candidate INTEGER DEFAULT 0,
  ghost_airport TEXT,
  total_legs INTEGER DEFAULT 0,
  legs_last_30d INTEGER DEFAULT 0,
  updated_at TEXT
);

-- ── fleet_stats (Phase 6 Tier 3 — written by update-graph.ts) ───────────────

CREATE TABLE IF NOT EXISTS fleet_stats (
  aircraft_class TEXT PRIMARY KEY,
  total_tracked INTEGER DEFAULT 0,
  airborne INTEGER DEFAULT 0,
  idle INTEGER DEFAULT 0,
  ghost_candidates INTEGER DEFAULT 0,
  updated_at TEXT
);

-- ── 26: archive_progress ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS archive_progress (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed', 'no_release')),
  files_archived INTEGER NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  s3_prefix TEXT,
  archived_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- ── 27: analytics tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS operator_market_share (
  month TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  total_legs INTEGER NOT NULL DEFAULT 0,
  total_flight_hours REAL NOT NULL DEFAULT 0,
  market_share_pct REAL NOT NULL DEFAULT 0,
  avg_flight_time_min REAL NOT NULL DEFAULT 0,
  top_route TEXT,
  aircraft_classes JSONB,
  PRIMARY KEY (month, operator_name)
);
CREATE INDEX IF NOT EXISTS idx_oms_month ON operator_market_share(month);

CREATE TABLE IF NOT EXISTS aircraft_utilization (
  month TEXT NOT NULL,
  tail_number TEXT NOT NULL,
  icao_hex TEXT,
  operator_name TEXT,
  aircraft_class TEXT,
  total_legs INTEGER NOT NULL DEFAULT 0,
  total_flight_hours REAL NOT NULL DEFAULT 0,
  total_distance_nm REAL NOT NULL DEFAULT 0,
  days_active INTEGER NOT NULL DEFAULT 0,
  avg_daily_hours REAL NOT NULL DEFAULT 0,
  home_airport TEXT,
  PRIMARY KEY (month, tail_number)
);
CREATE INDEX IF NOT EXISTS idx_au_month ON aircraft_utilization(month);
CREATE INDEX IF NOT EXISTS idx_au_class ON aircraft_utilization(aircraft_class);
CREATE INDEX IF NOT EXISTS idx_au_operator ON aircraft_utilization(operator_name);

CREATE TABLE IF NOT EXISTS airport_activity (
  date TEXT NOT NULL,
  airport_icao TEXT NOT NULL,
  hour INTEGER NOT NULL,
  departures INTEGER NOT NULL DEFAULT 0,
  arrivals INTEGER NOT NULL DEFAULT 0,
  total_movements INTEGER NOT NULL DEFAULT 0,
  unique_aircraft INTEGER NOT NULL DEFAULT 0,
  charter_movements INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, airport_icao, hour)
);
CREATE INDEX IF NOT EXISTS idx_aa_airport ON airport_activity(airport_icao);
CREATE INDEX IF NOT EXISTS idx_aa_date ON airport_activity(date);

CREATE TABLE IF NOT EXISTS route_trends (
  month TEXT NOT NULL,
  origin_icao TEXT NOT NULL,
  destination_icao TEXT NOT NULL,
  total_flights INTEGER NOT NULL DEFAULT 0,
  avg_flight_time_min REAL NOT NULL DEFAULT 0,
  dominant_class TEXT,
  class_breakdown JSONB,
  yoy_change_pct REAL,
  PRIMARY KEY (month, origin_icao, destination_icao)
);
CREATE INDEX IF NOT EXISTS idx_rt_month ON route_trends(month);
CREATE INDEX IF NOT EXISTS idx_rt_route ON route_trends(origin_icao, destination_icao);

CREATE TABLE IF NOT EXISTS fleet_snapshot (
  date TEXT NOT NULL,
  aircraft_class TEXT NOT NULL,
  total_registered INTEGER NOT NULL DEFAULT 0,
  total_tracked INTEGER NOT NULL DEFAULT 0,
  total_airborne INTEGER NOT NULL DEFAULT 0,
  total_idle INTEGER NOT NULL DEFAULT 0,
  avg_utilization_hours REAL NOT NULL DEFAULT 0,
  new_registrations INTEGER NOT NULL DEFAULT 0,
  deregistrations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, aircraft_class)
);
CREATE INDEX IF NOT EXISTS idx_fs_class ON fleet_snapshot(aircraft_class);

CREATE TABLE IF NOT EXISTS fuel_burn_estimates (
  aircraft_class TEXT PRIMARY KEY,
  avg_gph REAL NOT NULL,
  avg_fuel_price_per_gallon REAL NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

INSERT INTO fuel_burn_estimates (aircraft_class, avg_gph, avg_fuel_price_per_gallon)
VALUES ('light', 150, 6.50), ('midsize', 220, 6.50), ('super_mid', 280, 6.50),
       ('heavy', 350, 6.50), ('turboprop', 80, 6.50)
ON CONFLICT (aircraft_class) DO NOTHING;

-- ── 28: FAA reference tables ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS faa_deregistered (
  id SERIAL PRIMARY KEY,
  tail_number TEXT NOT NULL,
  serial_number TEXT,
  manufacturer TEXT,
  model TEXT,
  common_name TEXT,
  aircraft_class TEXT,
  year_manufactured TEXT,
  owner_name TEXT,
  owner_city TEXT,
  owner_state TEXT,
  owner_country TEXT,
  certificate_holder TEXT,
  cancel_date TEXT,
  last_action_date TEXT,
  status TEXT,
  mode_s_hex TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_faa_dereg_tail ON faa_deregistered(tail_number);
CREATE INDEX IF NOT EXISTS idx_faa_dereg_cancel ON faa_deregistered(cancel_date);
CREATE INDEX IF NOT EXISTS idx_faa_dereg_holder ON faa_deregistered(certificate_holder);

CREATE TABLE IF NOT EXISTS faa_aircraft_types (
  model_code TEXT PRIMARY KEY,
  manufacturer TEXT,
  model TEXT,
  type_aircraft TEXT,
  num_engines INTEGER,
  num_seats INTEGER,
  weight_class TEXT,
  speed TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS faa_engine_types (
  engine_code TEXT PRIMARY KEY,
  manufacturer TEXT,
  model TEXT,
  type_engine TEXT,
  horsepower TEXT,
  thrust TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- ── 29: NTSB accidents ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ntsb_accidents (
  event_id TEXT PRIMARY KEY,
  investigation_type TEXT,
  event_date TEXT,
  location TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  latitude REAL,
  longitude REAL,
  airport_code TEXT,
  airport_name TEXT,
  injury_severity TEXT,
  aircraft_damage TEXT,
  registration_number TEXT,
  aircraft_make TEXT,
  aircraft_model TEXT,
  aircraft_category TEXT,
  amateur_built TEXT,
  number_of_engines INTEGER,
  engine_type TEXT,
  far_description TEXT,
  total_fatal_injuries INTEGER,
  total_serious_injuries INTEGER,
  total_minor_injuries INTEGER,
  total_uninjured INTEGER,
  weather_condition TEXT,
  broad_phase_of_flight TEXT,
  report_status TEXT,
  publication_date TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ntsb_reg ON ntsb_accidents(registration_number);
CREATE INDEX IF NOT EXISTS idx_ntsb_date ON ntsb_accidents(event_date);
CREATE INDEX IF NOT EXISTS idx_ntsb_airport ON ntsb_accidents(airport_code);
CREATE INDEX IF NOT EXISTS idx_ntsb_far ON ntsb_accidents(far_description);
CREATE INDEX IF NOT EXISTS idx_ntsb_severity ON ntsb_accidents(injury_severity);

-- ── 30: data_quality_runs ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS data_quality_runs (
  id SERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  malformed_tails INTEGER NOT NULL DEFAULT 0,
  invalid_icao INTEGER NOT NULL DEFAULT 0,
  duplicate_legs INTEGER NOT NULL DEFAULT 0,
  orphaned_records INTEGER NOT NULL DEFAULT 0,
  empty_fields INTEGER NOT NULL DEFAULT 0,
  stale_data INTEGER NOT NULL DEFAULT 0,
  anomalies INTEGER NOT NULL DEFAULT 0,
  overall_status TEXT NOT NULL CHECK (overall_status IN ('green', 'yellow', 'red')),
  details JSONB,
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- ── 32: validation_reports (Phase 2 D4 — cross-validation vs adsb.lol) ─────
-- One row per UTC date. Recorded by src/ingestion/cross-validate.ts after each
-- comparison run (status 'complete' | 'failed' | 'missing_source').
-- Apply in Supabase manually; cross-validate.ts also issues CREATE TABLE IF
-- NOT EXISTS at startup.

CREATE TABLE IF NOT EXISTS validation_reports (
  date TEXT PRIMARY KEY,
  validated_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL,

  osa_aircraft INTEGER,
  adsblol_aircraft INTEGER,
  aircraft_in_both INTEGER,
  aircraft_only_osa INTEGER,
  aircraft_only_adsblol INTEGER,

  osa_positions INTEGER,
  adsblol_positions INTEGER,
  avg_positions_per_aircraft_osa REAL,
  avg_positions_per_aircraft_adsblol REAL,

  aircraft_overlap_pct REAL,
  position_density_ratio REAL,

  sample_missing_hex_osa JSONB,
  sample_missing_hex_adsblol JSONB,
  sample_hex_both JSONB,

  osa_tar_s3_key TEXT,
  adsblol_tar_s3_key TEXT,
  error_message TEXT
);

-- ── 31: osa_position_archive (Phase 2 D2 — nightly packager audit) ──────────
-- One row per UTC day, recorded by src/ingestion/package-positions.ts after
-- each run (complete or failed). Primary key is the date so re-runs are
-- idempotent via UPSERT. package-positions.ts also issues CREATE TABLE IF NOT
-- EXISTS at startup as a safety net since we don't have a PG migration runner.

CREATE TABLE IF NOT EXISTS osa_position_archive (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  rows INTEGER,
  distinct_aircraft INTEGER,
  compressed_bytes BIGINT,
  positions_sha256 TEXT,
  tar_sha256 TEXT,
  s3_parquet_key TEXT,
  s3_tar_key TEXT,
  s3_manifest_key TEXT,
  packaged_at TIMESTAMPTZ DEFAULT NOW(),
  error_message TEXT
);
