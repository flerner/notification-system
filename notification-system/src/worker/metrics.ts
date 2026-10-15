import { Gauge, type Registry } from "prom-client";
import type { GuardedProvider } from "../providers/guarded.js";

const STATE = { closed: 0, half_open: 1, open: 2 } as const;

export function registerCircuitGauge(registry: Registry, providers: Record<string, GuardedProvider>): void {
  new Gauge({
    name: "provider_circuit_state",
    help: "Circuit breaker state per provider: 0 closed, 1 half open, 2 open.",
    labelNames: ["provider"],
    registers: [registry],
    collect() {
      for (const provider of Object.values(providers)) this.set({ provider: provider.name }, STATE[provider.state]);
    },
  });
}
