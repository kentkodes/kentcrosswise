// Copy of agents/orchestrator/test/pg-socket.ts (plus a fixed port option) for local Playwright runs.
// Test helper: serves one PGlite database over the Postgres wire protocol on 127.0.0.1, so the
// production code path (node-postgres Pool -> withDb / PostgresSaver) runs unchanged against it.
// PGlite is a single backend: every connection shares one session. A connection that opens a
// transaction (ReadyForQuery status 'T') or fails inside one ('E') owns the session until that
// transaction ends ('I') or the connection closes (its open transaction is rolled back). Other
// connections' messages wait meanwhile, so transactions from several pool connections never
// interleave (no role leaks, no "current transaction is aborted"). Each connection's messages
// still run in arrival order.
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { PGlite } from "@electric-sql/pglite";

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const TERMINATE = 0x58; // 'X'
const READY_FOR_QUERY = 0x5a; // 'Z'
const TX_IDLE = 0x49; // 'I' (not in a transaction)

export interface PgSocketServer {
  /** postgres://... URL for node-postgres (no password; PGlite does not check one). */
  url: string;
  close(): Promise<void>;
}

export interface ServeOptions {
  /** `SET ROLE` to this role after each connection's startup (PGlite ignores the startup user). */
  role?: string;
  /** Fixed port (default: a free one). */
  port?: number;
}

/** Transaction status byte of the last ReadyForQuery in a protocol response, or undefined. */
function lastTxStatus(out: Uint8Array): number | undefined {
  const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  let status: number | undefined;
  for (let i = 0; i + 5 <= buf.length; ) {
    const len = buf.readInt32BE(i + 1);
    if (len < 4) break;
    if (buf[i] === READY_FOR_QUERY && i + 5 < buf.length) status = buf[i + 5];
    i += 1 + len;
  }
  return status;
}

export async function servePglite(db: PGlite, opts: ServeOptions = {}): Promise<PgSocketServer> {
  await db.waitReady;

  // Jobs run one at a time. While `owner` holds an open transaction, only its jobs are eligible.
  interface Job {
    socket: Socket;
    run: () => Promise<void>;
  }
  const jobs: Job[] = [];
  let running = false;
  let owner: Socket | undefined;

  const pump = (): void => {
    if (running) return;
    const i = jobs.findIndex((j) => owner === undefined || j.socket === owner);
    if (i < 0) return;
    const job = jobs.splice(i, 1)[0];
    if (!job) return;
    running = true;
    void job.run().finally(() => {
      running = false;
      pump();
    });
  };
  const schedule = <T>(socket: Socket, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      jobs.push({ socket, run: () => fn().then(resolve, reject) });
      pump();
    });
  // Ends the transaction a closed connection left open. Harmless if the session is already idle.
  const abort = (socket: Socket) => async () => {
    if (owner !== socket) return;
    owner = undefined;
    await db.exec("ROLLBACK").catch(() => undefined);
  };

  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      // Its queued messages never run. A transaction it still holds is rolled back.
      for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i]?.socket === socket) jobs.splice(i, 1);
      if (owner === socket) void schedule(socket, abort(socket)).catch(() => undefined);
    });
    // A client process that exits without closing its connection resets the socket; that ends
    // this connection only and must not become an uncaught error in the test run.
    socket.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    let started = false;
    const fail = (e: unknown) => socket.destroy(e as Error);

    const exec = (msg: Uint8Array) =>
      schedule(socket, async () => {
        const out = await db.execProtocolRaw(msg);
        const status = lastTxStatus(out);
        if (status === TX_IDLE) {
          if (owner === socket) owner = undefined;
        } else if (status !== undefined) {
          owner = socket;
        }
        if (out.length > 0 && !socket.destroyed) socket.write(out);
        // Closed while this batch was running: it may have left a transaction open.
        if (owner === socket && !sockets.has(socket)) void schedule(socket, abort(socket)).catch(() => undefined);
      });

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const ready: Buffer[] = [];
      for (;;) {
        if (!started) {
          // Startup phase: messages have no type byte.
          if (buf.length < 8) break;
          const len = buf.readInt32BE(0);
          if (buf.length < len) break;
          const code = buf.readInt32BE(4);
          const msg = buf.subarray(0, len);
          buf = buf.subarray(len);
          if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
            socket.write("N"); // no TLS
            continue;
          }
          started = true;
          exec(msg).catch(fail);
          const role = opts.role;
          if (role) schedule(socket, async () => void (await db.exec(`SET ROLE ${role}`))).catch(fail);
          continue;
        }
        if (buf.length < 5) break;
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) break;
        const type = buf[0];
        const msg = buf.subarray(0, len + 1);
        buf = buf.subarray(len + 1);
        if (type === TERMINATE) {
          socket.end();
          continue;
        }
        ready.push(msg);
      }
      if (ready.length > 0) exec(Buffer.concat(ready)).catch(fail);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
