/**
 * Runs a script body and turns failures into a one-line message (plus its cause)
 * and exit code 1. No stack traces, no objects dumped: driver errors can be large,
 * and we never want a connection string or secret echoed into CI logs.
 */
export async function runMain(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    const parts: string[] = [];
    let cur: unknown = err;
    for (let i = 0; cur instanceof Error && i < 3; i++) {
      parts.push(cur.message);
      cur = cur.cause;
    }
    console.error(`error: ${parts.length ? parts.join(": ") : "unknown failure"}`);
    process.exitCode = 1;
  }
}
