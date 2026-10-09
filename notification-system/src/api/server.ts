import express, { type ErrorRequestHandler } from "express";
import { pino } from "pino";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { runHealthChecks, type HealthCheck } from "../infra/health.js";
import type { UserRepository } from "../users/repository.js";
import { userRoutes } from "./users.js";

// Built from injected pieces so tests can create an app without real Postgres/Redis/RabbitMQ.
export function buildServer(opts: { logLevel: string; healthChecks: HealthCheck[]; users: UserRepository }) {
  const logger = pino({ level: opts.logLevel });
  const app = express();

  app.use(pinoHttp({ logger })); // one structured log line per request
  app.use(express.json({ limit: "100kb" }));

  // Liveness: the process is up. Used by nothing that should restart us on a dependency outage.
  app.get("/live", (_req, res) => {
    res.json({ ok: true });
  });

  // Readiness: can we actually serve traffic? 503 tells load balancers to stop routing to us.
  app.get("/health", async (_req, res) => {
    const report = await runHealthChecks(opts.healthChecks);
    res.status(report.ok ? 200 : 503).json(report);
  });

  app.use(userRoutes(opts.users));

  // Express 5 forwards errors thrown or rejected inside handlers to this middleware.
  // Express recognises an error handler by its four parameters, so `_next` must stay.
  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation failed", issues: err.issues });
      return;
    }
    // e.g. malformed JSON from express.json(): the caller's fault, so pass its 4xx through.
    if (typeof err.status === "number" && err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal error" }); // don't leak internals
  };
  app.use(onError);

  return app;
}
