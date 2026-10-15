//   PENDING --claim--> SENDING --> SENT
//                         |------> FAILED            (permanent error, or attempts exhausted)
//                         |------> RETRYING --claim--> SENDING   (retryable error, waits in a retry queue)
//                         |------> SKIPPED_OPT_OUT      (the user opted out of this channel)
//                         |------> SKIPPED_RATE_LIMITED (the user already received their limit)
//                         '--(lease expired, claimed again)--> SENDING
export const STATUSES = ["PENDING", "SENDING", "RETRYING", "SENT", "FAILED", "SKIPPED_OPT_OUT", "SKIPPED_RATE_LIMITED"] as const;
export type Status = (typeof STATUSES)[number];

const TRANSITIONS: Record<Status, readonly Status[]> = {
  PENDING: ["SENDING"],
  SENDING: ["SENDING", "RETRYING", "SENT", "FAILED", "SKIPPED_OPT_OUT", "SKIPPED_RATE_LIMITED"],
  RETRYING: ["SENDING"],
  SENT: [],
  FAILED: [],
  SKIPPED_OPT_OUT: [],
  SKIPPED_RATE_LIMITED: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export function predecessors(to: Status): Status[] {
  return STATUSES.filter((s) => canTransition(s, to));
}

export function isTerminal(status: Status): boolean {
  return TRANSITIONS[status].length === 0;
}
