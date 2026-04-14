#!/bin/bash
# API smoke test — starts server, hits all endpoints, reports pass/fail.
# Usage: bash scripts/smoke-test.sh

set -e
PORT=${PORT:-3001}
BASE="http://localhost:$PORT"
PASS=0
FAIL=0
ERRORS=""

echo "=== Dumont API Smoke Test ==="
echo "Base: $BASE"
echo ""

# Start server in background
npx tsx src/server/index.ts &
SERVER_PID=$!
sleep 4

check() {
  local path="$1"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$path" 2>/dev/null)
  if [ "$status" = "200" ]; then
    echo "  PASS  $path ($status)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $path ($status)"
    FAIL=$((FAIL + 1))
    ERRORS="$ERRORS\n  $path → $status"
  fi
}

echo "── Intelligence Endpoints ──"
check "/health"
check "/api/aircraft/N143QS"
check "/api/aircraft/N143QS/flights?limit=2"
check "/api/airport/KORD/ghosts"
check "/api/fleet/stats"
check "/api/routes/KTEB/KPBI"
check "/api/market/listings?limit=2"
check "/api/market/transactions?limit=2"
check "/api/health/data"
check "/api/health/feed"
check "/api/health/quality"
check "/api/health/errors"

echo ""
echo "── Analytics Endpoints ──"
check "/api/analytics/market"
check "/api/analytics/operator/NETJETS%20AVIATION%20LLC"
check "/api/analytics/airport/KTEB"
check "/api/analytics/route/KTEB/KPBI"
check "/api/analytics/fleet"
check "/api/analytics/top-routes"
check "/api/analytics/top-operators"
check "/api/analytics/fuel/KTEB/KPBI/heavy"

echo ""
echo "── Dashboard ──"
check "/dashboard"

echo ""
echo "=== Summary ==="
echo "Pass: $PASS  Fail: $FAIL"
if [ $FAIL -gt 0 ]; then
  echo -e "Failed:$ERRORS"
fi

# Cleanup
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

exit $FAIL
