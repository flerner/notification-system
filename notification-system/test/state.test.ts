import { describe, expect, it } from "vitest";
import { canTransition, isTerminal, predecessors, STATUSES } from "../src/notifications/state.js";

describe("notification state machine", () => {
  it("lets PENDING and RETRYING notifications be claimed, and a SENDING one be re-claimed", () => {
    expect(predecessors("SENDING")).toEqual(["PENDING", "SENDING", "RETRYING"]);
  });

  it("only lets a SENDING notification wait for a retry", () => {
    expect(predecessors("RETRYING")).toEqual(["SENDING"]);
  });

  it("only lets a SENDING notification finish", () => {
    expect(predecessors("SENT")).toEqual(["SENDING"]);
    expect(predecessors("FAILED")).toEqual(["SENDING"]);
  });

  it("lets a SENDING attempt end as skipped because the user opted out, and nothing else", () => {
    expect(predecessors("SKIPPED_OPT_OUT")).toEqual(["SENDING"]);
  });

  it("never goes back to PENDING", () => {
    expect(predecessors("PENDING")).toEqual([]);
  });

  it("cannot skip the claim: PENDING -> SENT is illegal", () => {
    expect(canTransition("PENDING", "SENT")).toBe(false);
  });

  it("treats SENT and FAILED as terminal and nothing else", () => {
    expect(STATUSES.filter(isTerminal)).toEqual(["SENT", "FAILED", "SKIPPED_OPT_OUT"]);
  });
});
