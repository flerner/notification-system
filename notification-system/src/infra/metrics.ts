import { createServer, type Server } from "node:http";
import { collectDefaultMetrics, Registry } from "prom-client";

export function createRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return registry;
}

export function startMetricsServer(registry: Registry, port: number): Server {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": registry.contentType });
      res.end(await registry.metrics());
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return server;
}
