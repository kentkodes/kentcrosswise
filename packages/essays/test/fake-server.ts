import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: IncomingMessage, res: ServerResponse, hit: number) => void;

/** A loopback HTTP server for client tests: routes by path, records every request. No real site is contacted. */
export class FakeServer {
  readonly requests: Array<{ path: string; headers: IncomingMessage["headers"] }> = [];
  private readonly routes = new Map<string, Handler>();
  private readonly hits = new Map<string, number>();
  private server: Server | undefined;
  origin = "";

  route(path: string, handler: Handler): this {
    this.routes.set(path, handler);
    return this;
  }

  /** Replies with a fixed status, headers and body. */
  reply(path: string, status: number, body = "", headers: Record<string, string> = {}): this {
    return this.route(path, (_req, res) => {
      res.writeHead(status, headers);
      res.end(body);
    });
  }

  count(path: string): number {
    return this.hits.get(path) ?? 0;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const path = req.url ?? "/";
      const key = path.split("?")[0] ?? path;
      this.requests.push({ path, headers: req.headers });
      const hit = (this.hits.get(key) ?? 0) + 1;
      this.hits.set(key, hit);
      const handler = this.routes.get(key);
      if (handler) handler(req, res, hit);
      else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
