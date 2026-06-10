/**
 * Toba Graceful Shutdown
 * ======================
 * V1 and V2 hold separate connections to the same SQLite file. On shutdown both
 * are closed alongside the HTTP server. If any close hangs (e.g. a prepared
 * statement is still running) the process would hang forever with no timeout
 * (audit H3).
 *
 * `gracefulShutdown()` races all close operations against a bounded timeout
 * (default 5s). If the timeout wins it warns and returns so the caller can exit
 * anyway, rather than blocking indefinitely.
 */
export interface ShutdownOptions {
  timeoutMs?: number;
  onWarn?: (message: string) => void;
}

export async function gracefulShutdown(
  closers: Array<() => unknown | Promise<unknown>>,
  opts: ShutdownOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("shutdown timeout")), timeoutMs);
  });
  try {
    await Promise.race([
      Promise.all(closers.map((c) => Promise.resolve().then(c))),
      timeout,
    ]);
  } catch (err) {
    opts.onWarn?.(`Shutdown warning: ${(err as Error).message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
