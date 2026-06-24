/**
 * Run async tasks with a bounded concurrency (replaces Python's ThreadPoolExecutor).
 * Preserves input order in the returned results; calls onSettled as each finishes.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (index: number, result: R) => void
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const n = items.length;
  const size = Math.max(1, Math.min(limit, n));

  async function run(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= n) return;
      const r = await worker(items[i], i);
      results[i] = r;
      onSettled?.(i, r);
    }
  }

  await Promise.all(Array.from({ length: size }, run));
  return results;
}
