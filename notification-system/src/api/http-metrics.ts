import type { RequestHandler } from "express";
import { Counter, Histogram, type Registry } from "prom-client";

// Request count and duration per route. The label is the route PATTERN ("/users/:id/devices"), never
// the URL ("/users/123/devices"): every distinct id would otherwise become its own time series.
// A request that no route handled is labelled by why: refused by authentication, or not found.
export function httpMetrics(registry: Registry): RequestHandler {
  const requests = new Counter({
    name: "http_requests_total",
    help: "API requests by method, route and status.",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "http_request_duration_seconds",
    help: "API request duration by method and route.",
    labelNames: ["method", "route"],
    registers: [registry],
  });

  return (req, res, next) => {
    const stop = duration.startTimer();
    res.on("finish", () => {
      const route = req.route?.path ?? (res.statusCode === 401 ? "unauthenticated" : "unmatched");
      requests.inc({ method: req.method, route, status: String(res.statusCode) });
      stop({ method: req.method, route });
    });
    next();
  };
}
