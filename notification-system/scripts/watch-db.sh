#!/usr/bin/env bash
# Dev-only: redraws the notification log and the queue sizes every second, so you can watch a
# notification move through the system from another terminal. Ctrl+C to stop.
# Run from notification-system/ with the stack up.   Usage: ./scripts/watch-db.sh
while true; do
  out=$(
    echo "=== notifications        $(date +%H:%M:%S)"
    docker compose exec -T postgres psql -U notif -d notifications -c "SELECT left(id::text,8) AS id, user_id AS u, queue, status, published_at IS NOT NULL AS published, sent_at IS NOT NULL AS sent, left(coalesce(last_error,''),32) AS last_error FROM notifications ORDER BY created_at DESC LIMIT 12;" 2>&1
    echo "=== rabbitmq queues (ready = waiting, consumers = workers listening)"
    docker compose exec -T rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers 2>/dev/null | tail -n +3
  )
  clear; echo "$out"; sleep 1
done
