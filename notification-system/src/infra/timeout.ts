// A promise can't be cancelled from outside, so we race it against a timer that rejects.
// Whichever settles first wins; if the timer wins, the slow operation keeps running in the
// background and its result is ignored. The timer is cleared afterwards so successful
// calls don't leave a pending timeout behind.
export class TimeoutError extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
