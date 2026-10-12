#!/usr/bin/env bash
# Dev-only: redraws the interesting tables, the Redis cache and the queue sizes every second, so you
# can watch a notification move through the system from another terminal. Ctrl+C to stop.
# Run from notification-system/ with the stack up.   Usage: ./scripts/watch-db.sh
psql_() { docker compose exec -T postgres psql -U notif -d notifications "$@" 2>&1; }
while true; do
  out=$(
    echo "=== notifications        $(date +%H:%M:%S)   (lease = a worker owns it right now; body = the final text, already filled in)"
    psql_ -c "SELECT left(id::text,8) AS id, user_id AS u, queue, status, attempts AS tries, published_at IS NOT NULL AS published, (status = 'SENDING' AND lease_expires_at > now()) AS lease, left(payload->>'body',34) AS body, left(coalesce(last_error,''),28) AS last_error FROM notifications ORDER BY created_at DESC LIMIT 8;"
    echo "=== notification_settings (a missing row = opted in)"
    psql_ -c "SELECT user_id AS u, channel, opt_in FROM notification_settings ORDER BY user_id, channel;"
    echo "=== templates"
    psql_ -c "SELECT name, channel, left(subject,30) AS subject, left(body,40) AS body FROM templates ORDER BY name, channel;"
    echo "=== redis: cached templates (key, seconds left)"
    for k in $(docker compose exec -T redis redis-cli --scan --pattern 'template:*' 2>/dev/null | tr -d '\r'); do
      echo "$k   $(docker compose exec -T redis redis-cli ttl "$k" 2>/dev/null | tr -d '\r')s"
    done
    echo "=== redis: rate limit counters (key, notifications counted in this window, seconds until it resets)"
    for k in $(docker compose exec -T redis redis-cli --scan --pattern 'ratelimit:*' 2>/dev/null | tr -d '\r'); do
      echo "$k   count=$(docker compose exec -T redis redis-cli get "$k" 2>/dev/null | tr -d '\r')   resets in $(docker compose exec -T redis redis-cli ttl "$k" 2>/dev/null | tr -d '\r')s"
    done
    echo "=== rabbitmq queues (ready = waiting, unacked = a worker is handling it; *.retry.* shown only while holding a message)"
    docker compose exec -T rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers 2>/dev/null | tail -n +3 | awk -F'\t' 'NR == 1 || $1 !~ /\.retry\./ || $2 + $3 > 0' | column -t -s "$(printf '\t')"
  )
  clear; echo "$out"; sleep 1
done
