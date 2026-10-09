import Fastify from "fastify";
import { runHealthChecks, type HealthCheck } from "../infra/health.js";

// Built from injected pieces so tests can create a server without real Postgres/Redis/RabbitMQ.
export function buildServer(opts: { logLevel: string; healthChecks: HealthCheck[] }) {
  const app = Fastify({ logger: { level: opts.logLevel } });

  // Liveness: the process is up. Used by nothing that should restart us on a dependency outage.
  app.get("/live", async () => ({ ok: true }));

  // Readiness: can we actually serve traffic? 503 tells load balancers to stop routing to us.
  app.get("/health", async (_req, reply) => {
    const report = await runHealthChecks(opts.healthChecks);
    return reply.code(report.ok ? 200 : 503).send(report);
  });

  return app;
}
