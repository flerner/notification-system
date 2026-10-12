import { createServer, type Server } from "node:http";
import { collectDefaultMetrics, Registry } from "prom-client";

// One registry per process, with the standard process metrics (memory, CPU, event loop lag).
export function createRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return registry;
}

// Serves the registry for Prometheus to scrape. A separate port from the API's on purpose: the API
// port needs credentials and is the one callers use, while metrics are for operators and must not
// be reachable from outside (the port is not published by Docker, only Prometheus reaches it). The
// worker has no HTTP server at all, so it uses this too.
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
