import { defineConfig } from "vitest/config";

export default defineConfig({
  // The Postgres integration tests share one database and TRUNCATE its tables, so test files
  // must not run in parallel. The suite is small enough that this costs nothing.
  test: { fileParallelism: false },
});
