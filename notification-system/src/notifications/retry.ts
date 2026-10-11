// How many times, and how far apart, a failing notification is retried. Exponential-looking
// delays (e.g. 5 s, 30 s, 2 min) give a struggling provider time to recover instead of hammering
// it. There is no random jitter: each delay is a fixed-TTL queue (see queues.ts). The spread
// comes from notifications failing at different moments.
export class RetryPolicy {
  constructor(readonly delaysMs: readonly number[]) {}

  // The first attempt plus one retry per delay.
  get maxAttempts(): number {
    return this.delaysMs.length + 1;
  }

  // Delay before the next attempt after `attemptsMade` attempts, or undefined when that was the last.
  delayAfter(attemptsMade: number): number | undefined {
    return this.delaysMs[attemptsMade - 1];
  }
}
