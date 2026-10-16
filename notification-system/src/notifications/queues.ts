import { PLATFORMS, type Platform } from "../users/repository.js";

export const CHANNELS = ["push", "sms", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export type Queue = `push.${Platform}` | "sms" | "email";

export const QUEUES: readonly Queue[] = [
  ...PLATFORMS.map((platform) => `push.${platform}` as const),
  "sms",
  "email",
];

export const DEAD_LETTER_QUEUE = "dead-letter";

export function queueFor(channel: Channel, platform: Platform | null): Queue {
  return channel === "push" ? (`push.${platform}` as Queue) : channel;
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
