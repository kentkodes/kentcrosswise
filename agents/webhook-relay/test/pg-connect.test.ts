// The relay's database client gives up connecting after RELAY_PG_CONNECTION_TIMEOUT_MS, well inside
// GitHub's 10 s delivery timeout. Checked against a local listener that accepts and never answers.
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RELAY_PG_CONNECTION_TIMEOUT_MS, openPg, relayPgConfig } from "../src/lambda";

describe("relay database connect timeout", () => {
  it("passes a 3 s connect timeout to node-postgres, and no query or statement timeout", () => {
    expect(RELAY_PG_CONNECTION_TIMEOUT_MS).toBe(3000);
    expect(relayPgConfig("postgres://synthetic.invalid/db")).toEqual({
      connectionString: "postgres://synthetic.invalid/db",
      connectionTimeoutMillis: 3000,
    });
  });

  describe("against a server that never answers", () => {
    let server: Server;
    let port: number;
    const sockets: Socket[] = [];
    beforeAll(async () => {
      server = createServer((s) => sockets.push(s)); // accepts, never speaks the protocol
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as { port: number }).port;
    });
    afterAll(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("rejects after about 3 s instead of hanging", async () => {
      const started = Date.now();
      await expect(openPg(`postgres://synthetic:synthetic@127.0.0.1:${port}/db`)).rejects.toThrow(/timeout/i);
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(RELAY_PG_CONNECTION_TIMEOUT_MS - 100);
      expect(waited).toBeLessThan(RELAY_PG_CONNECTION_TIMEOUT_MS + 3000);
    }, 15_000);
  });
});
