// The notification state machine, in one place. Nothing else decides which status changes are
// legal: the repository builds its SQL guards from predecessors(), so an illegal change simply
// matches no row.
//
//   PENDING --claim--> SENDING --> SENT
//                         |------> FAILED            (permanent error, or attempts exhausted)
//                         |------> RETRYING --claim--> SENDING   (retryable error, waits in a retry queue)
//                         |------> SKIPPED_OPT_OUT   (the user opted out of this channel)
//                         '--(lease expired, claimed again)--> SENDING
export const STATUSES = ["PENDING", "SENDING", "RETRYING", "SENT", "FAILED", "SKIPPED_OPT_OUT"] as const;
export type Status = (typeof STATUSES)[number];

const TRANSITIONS: Record<Status, readonly Status[]> = {
  PENDING: ["SENDING"],
  // SENDING -> SENDING is the re-claim of a row whose worker crashed (lease expired).
  SENDING: ["SENDING", "RETRYING", "SENT", "FAILED", "SKIPPED_OPT_OUT"],
  RETRYING: ["SENDING"],
  SENT: [],
  FAILED: [],
  SKIPPED_OPT_OUT: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

// Statuses from which `to` may be reached.
export function predecessors(to: Status): Status[] {
  return STATUSES.filter((s) => canTransition(s, to));
}

// Terminal states never change again: a message for such a notification can be dropped.
export function isTerminal(status: Status): boolean {
  return TRANSITIONS[status].length === 0;
}
