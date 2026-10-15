export class RetryPolicy {
  constructor(readonly delaysMs: readonly number[]) {}

  get maxAttempts(): number {
    return this.delaysMs.length + 1;
  }

  delayAfter(attemptsMade: number): number | undefined {
    return this.delaysMs[attemptsMade - 1];
  }
}
