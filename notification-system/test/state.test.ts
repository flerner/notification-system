import { describe, expect, it } from "vitest";
import { canTransition, isTerminal, predecessors, STATUSES } from "../src/notifications/state.js";

describe("notification state machine", () => {
  it("only lets a PENDING notification be claimed, and a SENDING one be re-claimed", () => {
    expect(predecessors("SENDING")).toEqual(["PENDING", "SENDING"]);
  });

  it("only lets a SENDING notification finish", () => {
    expect(predecessors("SENT")).toEqual(["SENDING"]);
    expect(predecessors("FAILED")).toEqual(["SENDING"]);
  });

  it("never goes back to PENDING", () => {
    expect(predecessors("PENDING")).toEqual([]);
  });

  it("cannot skip the claim: PENDING -> SENT is illegal", () => {
    expect(canTransition("PENDING", "SENT")).toBe(false);
  });

  it("treats SENT and FAILED as terminal and nothing else", () => {
    expect(STATUSES.filter(isTerminal)).toEqual(["SENT", "FAILED"]);
  });
});
