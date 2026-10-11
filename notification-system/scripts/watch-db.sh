#!/usr/bin/env bash
# Dev-only: redraws the notification log, the idempotency keys and the queue sizes every second,
# so you can watch a notification move through the system from another terminal. Ctrl+C to stop.
# Run from notification-system/ with the stack up.   Usage: ./scripts/watch-db.sh
psql_() { docker compose exec -T postgres psql -U notif -d notifications "$@" 2>&1; }
while true; do
  out=$(
    echo "=== notifications        $(date +%H:%M:%S)   (lease = a worker currently owns it)"
    psql_ -c "SELECT left(id::text,8) AS id, left(request_id::text,8) AS request, user_id AS u, queue, status, attempts AS tries, published_at IS NOT NULL AS published, (status = 'SENDING' AND lease_expires_at > now()) AS lease, sent_at IS NOT NULL AS sent, left(coalesce(last_error,''),30) AS last_error FROM notifications ORDER BY created_at DESC LIMIT 10;"
    echo "=== idempotency_keys"
    psql_ -c "SELECT key, left(request_id::text,8) AS request, left(request_hash,8) AS hash FROM idempotency_keys ORDER BY created_at DESC LIMIT 5;"
    echo "=== rabbitmq queues (ready = waiting, unacked = a worker is handling it)"
    # column -t re-aligns rabbitmqctl's tab-separated output, which looks ragged otherwise
    docker compose exec -T rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers 2>/dev/null | tail -n +3 | column -t -s "$(printf '\t')"
  )
  clear; echo "$out"; sleep 1
done
