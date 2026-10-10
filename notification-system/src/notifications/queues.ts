import type { Platform } from "../users/repository.js";

export type Channel = "push" | "sms" | "email";

// One queue per channel (and per platform for push), so an outage of one third-party provider
// backs up only its own queue and never blocks the others (book Fig. 10-10).
export const QUEUES = ["push.ios", "push.android", "push.web", "sms", "email"] as const;

export function queueFor(channel: Channel, platform: Platform | null): string {
  return channel === "push" ? `push.${platform}` : channel;
}
