import type { Platform } from "../users/repository.js";

export type Channel = "push" | "sms" | "email";

export const QUEUES = [
  "push.ios",
  "push.android",
  "push.web",
  "sms",
  "email",
] as const;

export const DEAD_LETTER_QUEUE = "dead-letter";

export function queueFor(channel: Channel, platform: Platform | null): string {
  return channel === "push" ? `push.${platform}` : channel;
}

export interface QueueSpec {
  name: string;
  args?: Record<string, unknown>;
}

export function retryQueueName(queue: string, delayMs: number): string {
  return `${queue}.retry.${delayMs}`;
}

export function allQueues(retryDelaysMs: readonly number[]): QueueSpec[] {
  return [
    ...QUEUES.map((name) => ({ name })),
    ...QUEUES.flatMap((queue) =>
      retryDelaysMs.map((delay) => ({
        name: retryQueueName(queue, delay),
        args: {
          "x-message-ttl": delay,
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": queue,
        },
      })),
    ),
    { name: DEAD_LETTER_QUEUE },
  ];
}
