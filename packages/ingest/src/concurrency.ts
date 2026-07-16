/**
 * Run `fn` over `items` with at most `limit` in flight at once.
 *
 * The enrichment tiers are network-bound (RPC + data API), so doing them one at a
 * time wastes almost all of the wall clock. A pool of N workers is ~N× faster; keep
 * N modest so we stay inside RPC rate limits.
 *
 * Failures are isolated: a rejected item is reported to `onError` and skipped, the
 * rest keep going (one bad wallet must never stall an 88k backlog).
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onError?: (item: T, err: Error) => void,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        onError?.(items[i]!, err as Error);
      }
    }
  });
  await Promise.all(workers);
  return results;
}
