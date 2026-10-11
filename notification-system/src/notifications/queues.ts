import type { Platform } from "../users/repository.js";

export type Channel = "push" | "sms" | "email";

// One queue per channel (and per platform for push), so an outage of one third-party provider
// backs up only its own queue and never blocks the others (book Fig. 10-10).
export const QUEUES = ["push.ios", "push.android", "push.web", "sms", "email"] as const;

// Where messages go when we give up on them (malformed, permanently failed, attempts exhausted).
// It is a signal for operators: the notifications table is the source of truth.
export const DEAD_LETTER_QUEUE = "dead-letter";

export function queueFor(channel: Channel, platform: Platform | null): string {
  return channel === "push" ? `push.${platform}` : channel;
}

export interface QueueSpec {
  name: string;
  args?: Record<string, unknown>;
}

// A retry queue holds a failed notification's message for `delayMs`, then the broker moves it
// back to the main queue by itself: when a message's TTL expires the queue "dead-letters" it to
// the default exchange ("") with routing key = the main queue name. No timers in our code.
// One queue per delay: all messages in a queue share one TTL, because RabbitMQ only expires
// messages at the head of a queue, so mixed TTLs would block each other.
export function retryQueueName(queue: string, delayMs: number): string {
  return `${queue}.retry.${delayMs}`;
}

// Every queue the system uses. Declared by every process that connects (declaring is idempotent),
// so it does not matter which one starts first.
export function allQueues(retryDelaysMs: readonly number[]): QueueSpec[] {
  return [
    ...QUEUES.map((name) => ({ name })),
    ...QUEUES.flatMap((queue) =>
      retryDelaysMs.map((delay) => ({
        name: retryQueueName(queue, delay),
        args: { "x-message-ttl": delay, "x-dead-letter-exchange": "", "x-dead-letter-routing-key": queue },
      })),
    ),
    { name: DEAD_LETTER_QUEUE },
  ];
}
