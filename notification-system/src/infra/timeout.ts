// A promise can't be cancelled from outside, so we race it against a timer that rejects.
// Whichever settles first wins; if the timer wins, the slow operation keeps running in the
// background and its result is ignored. The timer is cleared afterwards so successful
// calls don't leave a pending timeout behind.
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
