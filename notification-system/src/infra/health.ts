import { withTimeout } from "./timeout.js";

// A dependency check is just a name plus a function that throws when the dependency is unhealthy.
export interface HealthCheck {
  name: string;
  check: () => Promise<void>;
}

export type HealthReport = {
  ok: boolean;
  checks: Record<string, "up" | "down">;
};

// Every check gets its own timeout: a hung dependency must make /health report "down"
// quickly, not hang the health endpoint (and with it the container healthcheck).
export async function runHealthChecks(checks: HealthCheck[], timeoutMs = 2000): Promise<HealthReport> {
  const results = await Promise.all(
    checks.map(async ({ name, check }) => {
      try {
        await withTimeout(check(), timeoutMs);
        return [name, "up"] as const;
      } catch {
        return [name, "down"] as const;
      }
    }),
  );
  return { ok: results.every(([, s]) => s === "up"), checks: Object.fromEntries(results) };
}
