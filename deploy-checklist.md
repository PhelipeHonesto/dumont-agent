# Dumont Agent — Railway Deployment Checklist

## 1. Create Railway Project

```
railway login
railway init
```

Or create via dashboard: https://railway.app/new

## 2. Create Persistent Volume

In Railway dashboard:
- Go to project settings
- Add a Volume
- Mount path: `/data`
- Size: 5GB (database is ~2.7GB, leaves room for growth + WAL)

## 3. Upload Initial Database

```bash
# Option A: Railway CLI
railway volume cp ./data/dumont.db /data/dumont.db

# Option B: SSH into a one-off service
railway run bash
# Then scp or wget the database into /data/
```

Verify the file exists:
```bash
railway run -- ls -lh /data/dumont.db
```

## 4. Set Environment Variables

Set these on ALL services (web, worker, crons):

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_PATH` | `/data/dumont.db` | Shared volume path |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Required for server + pipeline |
| `NODE_ENV` | `production` | Strict CORS, auth enforcement |
| `VAPI_SECRET` | `...` | Web service only — authenticates Vapi webhooks |
| `ALLOWED_ORIGINS` | `https://dashboard.osa.aero` | Comma-separated CORS origins |

## 5. Deploy Services

### Web Service (Express API)
- Start command: `npm run server`
- Port: 3001
- Health check: GET `/health`
- Volume mount: `/data`

### Worker Service (ADS-B Live Feed)
- Start command: `npm run adsb:live`
- No port (background worker)
- Volume mount: `/data`
- Restart on failure

### Cron: Nightly Pipeline
- Command: `npm run pipeline`
- Schedule: `0 3 * * *` (3 AM UTC)
- Volume mount: `/data`

### Cron: Health Check
- Command: `npm run health:check`
- Schedule: `*/15 * * * *` (every 15 min)
- Volume mount: `/data`

## 6. Verify Each Service

### Web API
```bash
curl https://your-app.railway.app/health
curl https://your-app.railway.app/api/fleet/stats
curl https://your-app.railway.app/api/health/data
curl https://your-app.railway.app/api/health/feed
```

### ADS-B Worker
Check Railway logs for the worker service:
```
[adsb-live] Connected to adsb.lol feed
[adsb-live] Processing positions...
```

### Pipeline
Trigger a manual run:
```bash
railway run npm run pipeline
```
Then check:
```bash
curl https://your-app.railway.app/api/health/data
# pipeline.lastRun should be recent, status = "completed"
```

### Health Check
Check Railway cron logs — should show traffic light output every 15 min.

## 7. SQLite Concurrency Notes

- WAL mode is enabled — concurrent reads don't block writes
- `busy_timeout = 30000` — writers wait up to 30s for locks
- Only ONE writer at a time (SQLite limitation)
- The web server and worker both write, but contention is rare:
  - Worker writes positions every ~5s
  - Server writes on deal creation/updates (infrequent)
  - Pipeline writes nightly (brief burst)
- If you see `SQLITE_BUSY` errors in logs, increase `busy_timeout`

## 8. Backup Strategy

SQLite on a Railway volume has no automatic backups. Set up:

```bash
# Daily backup cron (add as Railway cron service)
# Command: sqlite3 /data/dumont.db ".backup /data/backups/dumont-$(date +%Y%m%d).db"
# Schedule: 0 4 * * * (4 AM UTC, after pipeline completes)
```

Or use Railway's volume snapshot feature if available.

## 9. Rollback

If a deployment breaks:
1. Railway auto-keeps previous deployments — rollback in dashboard
2. Database is on a volume — not affected by code deployments
3. If DB is corrupted: restore from backup, then redeploy
