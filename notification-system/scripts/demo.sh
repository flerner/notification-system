#!/usr/bin/env bash
# Dev-only demo of the flow as of M4: seed users, send notifications, let the workers deliver
# them (mock providers), then look at the notification log in Postgres and at the RabbitMQ
# queues. Run from notification-system/ with the stack up (`docker compose up -d`).
# Try it with several workers: `docker compose up -d --scale worker=3`.   Usage: ./scripts/demo.sh
set -u
J='content-type: application/json'
send() { curl -s -XPOST localhost:3000/v1/notifications -H "$J" -d "$1" -w '  [HTTP %{http_code}]\n'; }
sql()  { docker compose exec -T postgres psql -U notif -d notifications "$@"; }

echo "=== health";            curl -s localhost:3000/health; echo
echo "=== reset log + queues and seed users"
sql -qc "TRUNCATE notifications"
for q in push.ios push.android push.web sms email; do
  docker compose exec -T rabbitmq rabbitmqctl purge_queue "$q" >/dev/null 2>&1
done
npm run seed --silent

echo; echo "=== 1. push to Ana (she has an iOS and an Android device -> 2 notifications)"
send '{"userId":"1","channel":"push","subject":"Order shipped","body":"Your order is on its way"}'
echo "=== 2. sms to Ana";                send '{"userId":"1","channel":"sms","body":"Code: 1234"}'
echo "=== 3. email to Bob";              send '{"userId":"2","channel":"email","subject":"Receipt","body":"Thanks for your purchase"}'
echo "=== 4. sms to user 3 (phone only)"; send '{"userId":"3","channel":"sms","body":"Hello"}'

echo; echo "=== errors you should see"
echo "push to user 3 (no devices) -> 422:";  send '{"userId":"3","channel":"push","body":"x"}'
echo "unknown user -> 404:";                 send '{"userId":"99","channel":"email","body":"x"}'
echo "missing body -> 400:";                 send '{"userId":"1","channel":"email"}' | cut -c1-90

echo; echo "(waiting 2s for the workers)"; sleep 2
echo "=== notification log in Postgres (one row per destination)"
sql -c "SELECT left(id::text,8) AS id, user_id AS u, queue, destination, payload->>'body' AS body, status, published_at IS NOT NULL AS published, sent_at IS NOT NULL AS sent, last_error FROM notifications ORDER BY created_at;"

echo "=== RabbitMQ queues: messages still waiting and how many workers consume each"
docker compose exec -T rabbitmq rabbitmqctl list_queues name messages consumers 2>/dev/null | tail -n +3

echo; echo "=== what the workers did"
docker compose logs worker --no-log-prefix --tail 20 2>&1 | grep -E 'notification sent|delivery failed' | cut -c1-200 | tail -6
echo; echo "UI: http://localhost:15672 (notif / notif)"
