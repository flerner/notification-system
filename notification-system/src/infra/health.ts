import { withTimeout } from "./timeout.js";

export interface HealthCheck {
  name: string;
  check: () => Promise<void>;
}

export type HealthReport = {
  ok: boolean;
  checks: Record<string, "up" | "down">;
};

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
