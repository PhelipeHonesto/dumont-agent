/**
 * Operational dashboard — single self-contained HTML page.
 * GET /dashboard — no auth, read-only status.
 * Dark theme, OSA brand colors, auto-refreshes every 60s.
 */

import { Router, type Request, type Response } from "express";

export const dashboardRouter = Router();

dashboardRouter.get("/dashboard", (_req: Request, res: Response) => {
  res.type("html").send(DASHBOARD_HTML);
});

// ── HTML ────────────────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dumont — Operations Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, monospace; background: #1A1A1A; color: #F5F0E8; }
  .container { max-width: 1100px; margin: 0 auto; padding: 20px; }
  h1 { color: #E74B1D; font-size: 1.4rem; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 0.8rem; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  .card { background: #252525; border-radius: 8px; padding: 16px; border: 1px solid #333; }
  .card h2 { color: #E74B1D; font-size: 0.95rem; margin-bottom: 12px; border-bottom: 1px solid #333; padding-bottom: 6px; }
  .stat { display: flex; justify-content: space-between; padding: 4px 0; font-size: 0.85rem; }
  .stat .label { color: #999; }
  .stat .value { color: #F5F0E8; font-weight: 600; }
  .light { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .green { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
  .yellow { background: #eab308; box-shadow: 0 0 6px #eab308; }
  .red { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
  .gray { background: #666; }
  .error-row { font-size: 0.75rem; padding: 6px 0; border-bottom: 1px solid #333; }
  .error-row .time { color: #666; }
  .error-row .route { color: #E74B1D; }
  .error-row .msg { color: #ccc; }
  .loading { color: #666; font-style: italic; font-size: 0.8rem; }
  .refresh { color: #666; font-size: 0.7rem; text-align: right; margin-top: 12px; }
</style>
</head>
<body>
<div class="container">
  <h1>Dumont Operations Dashboard</h1>
  <p class="subtitle">Orange Sunshine Aviation — Intelligence Platform</p>

  <div class="grid">
    <div class="card">
      <h2>System Status</h2>
      <div id="system"><span class="loading">Loading...</span></div>
    </div>

    <div class="card">
      <h2>Data Health</h2>
      <div id="health"><span class="loading">Loading...</span></div>
    </div>

    <div class="card">
      <h2>Quick Stats</h2>
      <div id="stats"><span class="loading">Loading...</span></div>
    </div>

    <div class="card">
      <h2>Data Quality</h2>
      <div id="quality"><span class="loading">Loading...</span></div>
    </div>
  </div>

  <div class="grid" style="margin-top: 16px;">
    <div class="card" style="grid-column: 1 / -1;">
      <h2>Recent Errors</h2>
      <div id="errors"><span class="loading">Loading...</span></div>
    </div>
  </div>

  <div class="refresh" id="refresh"></div>
</div>

<script>
const BASE = window.location.origin;
const startTime = Date.now();

function light(status) {
  const cls = status === 'green' ? 'green' : status === 'yellow' ? 'yellow' : status === 'red' ? 'red' : 'gray';
  return '<span class="light ' + cls + '"></span>';
}

function stat(label, value) {
  return '<div class="stat"><span class="label">' + label + '</span><span class="value">' + value + '</span></div>';
}

function fmt(n) {
  return n != null ? Number(n).toLocaleString() : '—';
}

function ago(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return Math.round(ms/1000) + 's ago';
  if (ms < 3600000) return Math.round(ms/60000) + 'm ago';
  return Math.round(ms/3600000) + 'h ago';
}

async function fetchJson(path) {
  try {
    const r = await fetch(BASE + path);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function loadSystem() {
  const el = document.getElementById('system');
  const uptime = Math.round((Date.now() - startTime) / 1000);
  const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
  let html = stat('API', light('green') + ' running');
  html += stat('Page uptime', uptime + 's');
  if (mem) html += stat('JS heap', mem + ' MB');
  el.innerHTML = html;
}

async function loadHealth() {
  const el = document.getElementById('health');
  const [data, feed] = await Promise.all([fetchJson('/api/health/data'), fetchJson('/api/health/feed')]);
  let html = '';
  if (data) {
    html += stat('Overall', light(data.overall) + ' ' + (data.overall || 'unknown'));
    if (data.sources) {
      for (const [k, v] of Object.entries(data.sources)) {
        const s = v;
        html += stat(k, light(s.status || 'gray') + ' ' + (s.status || '?'));
      }
    }
  } else {
    html += stat('Data health', '<span style="color:#ef4444">unavailable</span>');
  }
  if (feed) {
    html += stat('ADS-B feed', light(feed.feedStatus === 'alive' ? 'green' : feed.feedStatus === 'stale' ? 'yellow' : 'red') + ' ' + (feed.feedStatus || '?'));
    if (feed.positionsPerHour != null) html += stat('Positions/hr', fmt(feed.positionsPerHour));
  }
  el.innerHTML = html;
}

async function loadStats() {
  const el = document.getElementById('stats');
  const data = await fetchJson('/api/fleet/stats');
  if (!data) { el.innerHTML = '<span style="color:#ef4444">unavailable</span>'; return; }
  let html = '';
  if (data.adsbTracked) {
    html += stat('Tracked aircraft', fmt(data.adsbTracked.total));
    html += stat('Airborne', fmt(data.adsbTracked.airborne));
    html += stat('Idle', fmt((data.adsbTracked.idleBase || 0) + (data.adsbTracked.idleTransient || 0)));
  }
  html += stat('Ghost candidates', fmt(data.ghostCandidates));
  html += stat('Registry total', fmt(data.registryTotal));
  el.innerHTML = html;
}

async function loadQuality() {
  const el = document.getElementById('quality');
  const data = await fetchJson('/api/health/quality');
  if (!data) { el.innerHTML = stat('Last run', 'no report yet — run npm run quality:check'); return; }
  let html = stat('Status', light(data.overallStatus) + ' ' + (data.overallStatus || '?'));
  html += stat('Last run', ago(data.runAt));
  if (data.checks) {
    const c = data.checks;
    if (c.malformedTails) html += stat('Malformed tails', fmt(c.malformedTails));
    if (c.invalidIcao) html += stat('Invalid ICAO', fmt(c.invalidIcao));
    if (c.duplicateLegs) html += stat('Duplicate legs', fmt(c.duplicateLegs));
    if (c.orphanedRecords) html += stat('Orphaned records', fmt(c.orphanedRecords));
    if (c.anomalies) html += stat('Anomalies', fmt(c.anomalies));
  }
  el.innerHTML = html;
}

async function loadErrors() {
  const el = document.getElementById('errors');
  const data = await fetchJson('/api/health/errors');
  if (!data || !data.errors || data.errors.length === 0) {
    el.innerHTML = '<span style="color:#22c55e; font-size:0.85rem;">No errors recorded</span>';
    return;
  }
  let html = '';
  for (const e of data.errors.slice(0, 10)) {
    html += '<div class="error-row">';
    html += '<span class="time">' + ago(e.timestamp) + '</span> ';
    html += '<span class="route">' + e.method + ' ' + e.route + '</span> ';
    html += '<span class="msg">' + (e.message || '').substring(0, 120) + '</span>';
    html += '</div>';
  }
  if (data.count > 10) html += '<div style="color:#666;font-size:0.75rem;margin-top:4px;">' + data.count + ' total errors</div>';
  el.innerHTML = html;
}

async function refresh() {
  await Promise.all([loadSystem(), loadHealth(), loadStats(), loadQuality(), loadErrors()]);
  document.getElementById('refresh').textContent = 'Last refresh: ' + new Date().toLocaleTimeString() + ' — auto-refreshes every 60s';
}

refresh();
setInterval(refresh, 60000);
</script>
</body>
</html>`;
