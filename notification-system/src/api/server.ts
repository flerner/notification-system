import express, { type ErrorRequestHandler } from "express";
import type { Logger } from "pino";
import type { Registry } from "prom-client";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import type { ClientRepository } from "../clients/repository.js";
import { runHealthChecks, type HealthCheck } from "../infra/health.js";
import type { NotificationService } from "../notifications/service.js";
import type { SettingsRepository } from "../notifications/settings.js";
import type { TemplateRepository } from "../notifications/templates.js";
import type { UserRepository } from "../users/repository.js";
import { requireClient } from "./auth.js";
import { httpMetrics } from "./http-metrics.js";
import { notificationRoutes } from "./notifications.js";
import { settingsRoutes } from "./settings.js";
import { templateRoutes } from "./templates.js";
import { userRoutes } from "./users.js";
import { httpStatusOf } from "./errors.js";

export function buildServer(opts: {
  logger: Logger;
  healthChecks: HealthCheck[];
  users: UserRepository;
  notifications: NotificationService;
  settings: SettingsRepository;
  templates: TemplateRepository;
  clients: ClientRepository;
  registry?: Registry;
}) {
  const app = express();

  // One structured log line per request. The request is logged as id, method and URL only: the
  // default also logs every header, which would put the caller's Authorization (their secret) in the
  // logs. The caller is identified by client id instead.
  app.use(
    pinoHttp({
      logger: opts.logger,
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }) },
      customProps: (_req, res) => ({ client: res.locals.client?.id }),
    }),
  );

  if (opts.registry) app.use(httpMetrics(opts.registry));

  app.get("/live", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/health", async (_req, res) => {
    const report = await runHealthChecks(opts.healthChecks);
    res.status(report.ok ? 200 : 503).json(report);
  });

  app.use(requireClient(opts.clients));
  app.use(express.json({ limit: "100kb" }));

  app.use(userRoutes(opts.users));
  app.use(notificationRoutes(opts.notifications));
  app.use(settingsRoutes(opts.settings));
  app.use(templateRoutes(opts.templates));

  // Express 5 forwards errors thrown or rejected inside handlers to this middleware.
  // Express recognises an error handler by its four parameters, so `_next` must stay.
  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation failed", issues: err.issues });
      return;
    }
    const status = httpStatusOf(err);
    if (status !== undefined) {
      res.status(status).json({ error: err.message });
      return;
    }
    if (typeof err.status === "number" && err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal error" });
  };
  app.use(onError);

  return app;
}
