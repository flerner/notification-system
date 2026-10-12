#!/usr/bin/env bash
# Dev-only: sends a mix of notifications for a while, so the Grafana dashboard has something to show.
# Needs the stack up and `npm run seed` done (it uses the demo client and the seeded users).
#   ./scripts/traffic.sh [seconds] [requests per second]      default: 60 seconds, 4 per second
# Tip: for more variety (failures, retries, skips) start the worker with, for example,
#   MOCK_FAILURE_RATE=0.3 RATE_LIMIT_EMAIL=20/60 docker compose up -d --force-recreate worker
set -u
seconds=${1:-60}; rate=${2:-4}
auth=(-u demo-key:demo-secret -H 'content-type: application/json')
url=localhost:3000/v1/notifications
# user:channel pairs that have a destination in the seed data (Ana: 1, Bob: 2, user 3 has a phone only)
targets=("1:email" "2:email" "1:sms" "3:sms" "1:push" "2:push")

n=0
end=$((SECONDS + seconds))
echo "sending about $rate notifications per second for ${seconds}s ..."
while [ $SECONDS -lt $end ]; do
  for _ in $(seq 1 "$rate"); do
    n=$((n + 1))
    pair=${targets[$((RANDOM % ${#targets[@]}))]}; user=${pair%%:*}; channel=${pair##*:}
    if [ $((RANDOM % 2)) -eq 0 ]; then
      body="{\"userId\":\"$user\",\"channel\":\"$channel\",\"template\":\"order-shipped\",\"params\":{\"name\":\"User$user\",\"order_id\":$n,\"eta\":\"Friday\"}}"
    else
      body="{\"userId\":\"$user\",\"channel\":\"$channel\",\"body\":\"traffic message $n\"}"
    fi
    (
      curl -s -o /dev/null "${auth[@]}" -H "Idempotency-Key: traffic-$$-$n" -XPOST $url -d "$body"
      # one request in ten is repeated, as a caller retrying after a timeout would
      [ $((RANDOM % 10)) -eq 0 ] && curl -s -o /dev/null "${auth[@]}" -H "Idempotency-Key: traffic-$$-$n" -XPOST $url -d "$body"
    ) &
  done
  sleep 1
done
wait
echo "sent $n requests"
