#!/usr/bin/env bash
# Dev-only: puts extra copies of a queue message on a queue, to watch the workers cope with
# duplicates (the claim makes only one of them send). The notification must already exist.
#   ./scripts/inject-duplicate.sh <notification-id> <queue> [copies]
#   e.g. ./scripts/inject-duplicate.sh 3a1c9f2e-... email 5
set -eu
id=$1; queue=$2; copies=${3:-3}
for _ in $(seq 1 "$copies"); do
  curl -s -u notif:notif -XPOST localhost:15672/api/exchanges/%2F/amq.default/publish \
    -H 'content-type: application/json' \
    -d "{\"properties\":{\"delivery_mode\":2},\"routing_key\":\"$queue\",\"payload\":\"{\\\"notificationId\\\":\\\"$id\\\"}\",\"payload_encoding\":\"string\"}" >/dev/null
done
echo "injected $copies copies of $id on queue $queue"
