import { writeFileSync } from "node:fs";

const ds = { type: "prometheus", uid: "prometheus" };
let nextId = 1;

type Query = [expr: string, legend?: string];
type Threshold = [value: number | null, color: string];

const targets = (queries: Query[]) =>
  queries.map(([expr, legendFormat], i) => ({ refId: String.fromCharCode(65 + i), expr, legendFormat: legendFormat ?? "", datasource: ds }));

function row(title: string, y: number) {
  return { id: nextId++, type: "row", title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] };
}

function stat(title: string, description: string, x: number, y: number, expr: string, thresholds: Threshold[], unit = "short", w = 6) {
  return {
    id: nextId++, type: "stat", title, description, datasource: ds,
    gridPos: { h: 4, w, x, y },
    targets: targets([[expr]]),
    fieldConfig: {
      defaults: { unit, thresholds: { mode: "absolute", steps: thresholds.map(([value, color]) => ({ value, color })) }, noValue: "0" },
      overrides: [],
    },
    options: { colorMode: "background", graphMode: "none", reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false }, textMode: "value" },
  };
}

function series(title: string, description: string, x: number, y: number, w: number, queries: Query[], unit = "short", noValue = "No data") {
  return {
    id: nextId++, type: "timeseries", title, description, datasource: ds,
    gridPos: { h: 8, w, x, y },
    targets: targets(queries),
    fieldConfig: { defaults: { unit, noValue, custom: { lineWidth: 2, fillOpacity: 10, showPoints: "never" } }, overrides: [] },
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "desc" } },
  };
}

function circuitTimeline(x: number, y: number, w: number) {
  return {
    id: nextId++, type: "state-timeline", title: "Provider circuit breakers", datasource: ds,
    description: "Closed is normal. Open means the provider is considered down: its notifications are held back and no attempts are used up. Half open is a trial after the cooldown.",
    gridPos: { h: 8, w, x, y },
    // max over the workers: one row per provider, open if the breaker is open in ANY worker. Without it,
    // every worker container (a scaled-out one, or a recreated one) draws its own set of rows.
    targets: targets([["max by (provider) (provider_circuit_state)", "{{provider}}"]]),
    fieldConfig: {
      defaults: {
        mappings: [{ type: "value", options: { "0": { text: "closed", color: "green" }, "1": { text: "half open", color: "yellow" }, "2": { text: "open", color: "red" } } }],
        custom: { fillOpacity: 80 },
      },
      overrides: [],
    },
    options: { showValue: "never", legend: { showLegend: true, placement: "bottom" }, tooltip: { mode: "single" } },
  };
}

const MAIN = 'queue!~".*retry.*|dead-letter"';
const q = (p: number, metric: string, by: string) => `histogram_quantile(${p}, sum by (le, ${by}) (rate(${metric}_bucket[5m])))`;

const panels = [
  row("At a glance", 0),
  stat("Waiting in queues", "Messages waiting for a worker, across the main queues. If it keeps growing, workers are too slow, so add workers.", 0, 1, `sum(rabbitmq_queue_messages_ready{${MAIN}})`, [[null, "green"], [100, "yellow"], [1000, "red"]]),
  stat("Dead-letter queue", "Notifications given up on, and messages that could not be read. Should be 0.", 6, 1, 'sum(rabbitmq_queue_messages_ready{queue="dead-letter"})', [[null, "green"], [1, "red"]]),
  stat("Failed for good (5 min)", "Given up on: a permanent error, or every attempt failed. Anything above 0 deserves a look.", 12, 1, "round(sum(increase(notifications_failed_total[5m])))", [[null, "green"], [1, "red"]]),
  stat("Workers listening", "The fewest workers serving any channel. 0 means some channel has nobody delivering it.", 18, 1, `min(sum by (queue) (rabbitmq_queue_consumers{${MAIN}}))`, [[null, "red"], [1, "green"]]),

  row("Flow", 5),
  series("Accepted vs sent (per second)", "Accepted by the API vs handed to a provider, by channel. If sent stays below accepted for long, a backlog is building.", 0, 6, 12, [
    ["sum by (channel) (rate(notifications_accepted_total[1m]))", "accepted {{channel}}"],
    ["sum by (channel) (rate(notifications_sent_total[1m]))", "sent {{channel}}"],
  ], "ops"),
  series("What becomes of notifications (per second)", "Every attempt ends here: sent, failed for good, skipped on purpose (opt-out or rate limit), or scheduled for a retry.", 12, 6, 12, [
    ["sum(rate(notifications_sent_total[1m]))", "sent"],
    ["sum by (reason) (rate(notifications_failed_total[1m]))", "failed ({{reason}})"],
    ["sum by (reason) (rate(notifications_skipped_total[1m]))", "skipped ({{reason}})"],
    ["sum by (channel) (rate(notification_retries_total[1m]))", "retry scheduled ({{channel}})"],
  ], "ops"),

  row("Queues and speed", 14),
  series("Waiting for a worker, by queue", "Ready messages per main queue: which channel is backing up.", 0, 15, 8, [[`rabbitmq_queue_messages_ready{${MAIN}}`, "{{queue}}"]]),
  series("Accepted to sent (p50 and p95)", "Time from the API storing a notification to the provider taking it. Includes queueing and retry waits, so a retried notification shows up in the tail.", 8, 15, 8, [
    [q(0.5, "notification_end_to_end_seconds", "channel"), "p50 {{channel}}"],
    [q(0.95, "notification_end_to_end_seconds", "channel"), "p95 {{channel}}"],
  ], "s"),
  circuitTimeline(16, 15, 8),
];

const dashboard = {
  uid: "notifications",
  title: "Notification system",
  description: "Is it keeping up, is anything being given up on, is it fast enough, and what is the traffic doing.",
  tags: ["notifications"],
  timezone: "browser",
  schemaVersion: 39,
  version: 1,
  refresh: "5s",
  time: { from: "now-15m", to: "now" },
  editable: false,
  panels,
};

writeFileSync("observability/grafana/dashboards/notifications.json", JSON.stringify(dashboard, null, 2) + "\n");
console.log(`wrote the dashboard: ${panels.filter((p) => p.type !== "row").length} panels`);
