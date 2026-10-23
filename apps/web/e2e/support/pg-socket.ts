// Copy of agents/orchestrator/test/pg-socket.ts (plus a fixed port option) for local Playwright runs.
// Test helper: serves one PGlite database over the Postgres wire protocol on 127.0.0.1, so the
// production code path (node-postgres Pool -> PostgresSaver) runs unchanged against it.
// PGlite is a single backend: every connection shares one session, and protocol exchanges are
// serialized. Use Pool max 1.
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { PGlite } from "@electric-sql/pglite";

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const TERMINATE = 0x58; // 'X'

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

export async function servePglite(db: PGlite, opts: ServeOptions = {}): Promise<PgSocketServer> {
  await db.waitReady;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const done = queue.then(fn);
    queue = done.catch(() => undefined);
    return done;
  };
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A client process that exits without closing its connection resets the socket; that ends
    // this connection only and must not become an uncaught error in the test run.
    socket.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    let started = false;
    const fail = (e: unknown) => socket.destroy(e as Error);

    const exec = (msg: Uint8Array) =>
      enqueue(async () => {
        const out = await db.execProtocolRaw(msg);
        if (out.length > 0 && !socket.destroyed) socket.write(out);
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
          if (role) enqueue(async () => void (await db.exec(`SET ROLE ${role}`))).catch(fail);
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
