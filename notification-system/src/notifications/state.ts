//   PENDING --claim--> SENDING --> SENT
//                         |------> FAILED            (permanent error, or attempts exhausted)
//                         |------> RETRYING --claim--> SENDING   (retryable error, waits in a retry queue)
//                         |------> SKIPPED_OPT_OUT      (the user opted out of this channel)
//                         |------> SKIPPED_RATE_LIMITED (the user already received their limit)
//   PENDING, RETRYING --> SKIPPED_STALE_DESTINATION (the device token moved to another user)
//                         '--(lease expired, claimed again)--> SENDING
export const STATUSES = ["PENDING", "SENDING", "RETRYING", "SENT", "FAILED", "SKIPPED_OPT_OUT", "SKIPPED_RATE_LIMITED", "SKIPPED_STALE_DESTINATION"] as const;
export type Status = (typeof STATUSES)[number];

const TRANSITIONS: Record<Status, readonly Status[]> = {
  PENDING: ["SENDING", "SKIPPED_STALE_DESTINATION"],
  SENDING: ["SENDING", "RETRYING", "SENT", "FAILED", "SKIPPED_OPT_OUT", "SKIPPED_RATE_LIMITED"],
  RETRYING: ["SENDING", "SKIPPED_STALE_DESTINATION"],
  SENT: [],
  FAILED: [],
  SKIPPED_OPT_OUT: [],
  SKIPPED_RATE_LIMITED: [],
  SKIPPED_STALE_DESTINATION: [],
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
