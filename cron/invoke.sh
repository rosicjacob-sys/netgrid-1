#!/bin/sh
set -eu
: "${APP_URL:?APP_URL must be set}"
: "${CRON_PATH:?CRON_PATH must be set}"
: "${CRON_SECRET:?CRON_SECRET must be set}"

# CRON_PATH may include a query string (e.g.
# "/api/cron/auto-publish?shard=0&shardCount=4"). The case statement
# below just prepends the URL scheme; the path + query passes through.
case "$APP_URL" in
  http://*|https://*) URL="${APP_URL}${CRON_PATH}" ;;
  *)                  URL="https://${APP_URL}${CRON_PATH}" ;;
esac

# Per-cron timeout, overridable from the cron service's env so slow paths
# can opt up without blanket-extending fast paths.
#
# MAX_TIME MUST SIT ABOVE THE ROUTE'S maxDuration, NEVER BELOW IT (T08).
# curl counts a --max-time expiry as a transient error and retries, but the
# Next handler it abandoned keeps running server-side: the retry then
# executes a SECOND copy of the same sweep. The old default of 660 sat only
# 60s above auto-publish's 600s maxDuration while a full run measured
# 425-595s, so the two distributions overlapped on ordinary days. Sizing
# MAX_TIME comfortably above maxDuration means the server always finishes
# (or returns an error) before curl gives up. Note --max-time is per
# ATTEMPT, so with retries the container can live for a multiple of this.
MAX_TIME="${CRON_MAX_TIME:-900}"

# Retries. curl's transient set is "timeout, 408, 429, 5xx" — a refused
# connection is NOT retried unless --retry-connrefused is given. The old
# flags therefore retried exactly the cases where the server was still
# working (its own timeout, or a 5xx from a function that hit its deadline)
# and skipped the one case where a retry is free and correct (the web
# service was mid-restart and refused the connection).
#
# Hourly non-idempotent crons should set CRON_RETRY=0: a missed tick is
# picked up by the next one, and the runner's own deferred-queue logic is
# designed for exactly that. A 400 is never retried at any setting, so a
# mis-typed CRON_PATH fails the container immediately.
RETRIES="${CRON_RETRY:-3}"

# -f is deliberately NOT used any more: it suppresses the response body on any
# HTTP status >= 400, which is exactly the body carrying {"error": "..."} from
# the route's catch block. We capture the body, print it, and translate the
# status into the exit code ourselves.
#
# The authoritative record of what happened is now the cron_runs row the route
# writes (see src/lib/services/run-telemetry.ts) — this output is for a human
# tailing the container during an incident.
BODY_FILE=$(mktemp)
STATUS=$(curl -sS --retry "$RETRIES" --retry-connrefused --max-time "$MAX_TIME" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  -o "$BODY_FILE" -w '%{http_code}' \
  "$URL") || STATUS="000"

echo "[cron] $(date -u +%Y-%m-%dT%H:%M:%SZ) ${CRON_PATH} -> HTTP ${STATUS}"
head -c 8000 "$BODY_FILE"
echo
rm -f "$BODY_FILE"

case "$STATUS" in
  2??) exit 0 ;;
  *)
    echo "[cron] FAILED: HTTP ${STATUS} for ${CRON_PATH}" >&2
    exit 1
    ;;
esac
