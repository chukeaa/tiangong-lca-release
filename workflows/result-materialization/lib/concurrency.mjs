export async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array(items.length);
  let next = 0;
  let firstError;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (!firstError) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        try {
          results[index] = await worker(items[index], index);
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );
  if (firstError) throw firstError;
  return results;
}
