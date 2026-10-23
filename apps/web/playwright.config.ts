// Playwright e2e (P1-14). Target: BASE_URL (a deployed preview), or a local server started here.
//   pnpm --filter web e2e                         local `next dev` (preview mode)
//   PW_SERVER=start pnpm --filter web e2e         local `next start`; needs `KCW_ENV=preview pnpm build-web`
//                                                 (or KCW_ENV=preview pnpm --filter web build) first
//   BASE_URL=https://... KCW_E2E_LOGIN=... pnpm --filter web e2e   a deployed preview
// The local server runs as a preview build with a fixed, non-secret login token, against an
// in-memory PGlite with the synthetic seed (e2e/support/local-db.ts) on port PW_DB_PORT.
import { defineConfig, devices } from "@playwright/test";

const LOCAL_PORT = Number(process.env.PW_PORT ?? 3917);
const LOCAL_E2E_LOGIN = "local-e2e-login-not-a-secret";
const LOCAL_DB_PORT = Number(process.env.PW_DB_PORT ?? 3918);

const remote = process.env.BASE_URL;
const baseURL = remote ?? `http://localhost:${LOCAL_PORT}`;
if (!remote) process.env.KCW_E2E_LOGIN ??= LOCAL_E2E_LOGIN;

const serverMode = process.env.PW_SERVER === "start" ? "start" : "dev";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    // Traces only on retry, and previews hold synthetic data only (R3).
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: remote
    ? undefined
    : [
        {
          command: "node ../../node_modules/tsx/dist/cli.mjs e2e/support/local-db.ts",
          port: LOCAL_DB_PORT,
          reuseExistingServer: false,
          timeout: 60_000,
          env: { PW_DB_PORT: String(LOCAL_DB_PORT) },
        },
        {
          command: `node node_modules/next/dist/bin/next ${serverMode} -p ${LOCAL_PORT}`,
          url: baseURL,
          reuseExistingServer: false,
          timeout: 180_000,
          env: {
            KCW_ENV: "preview",
            KCW_E2E_LOGIN: process.env.KCW_E2E_LOGIN ?? LOCAL_E2E_LOGIN,
            KCW_LOCAL_DATABASE_URL: `postgres://postgres@127.0.0.1:${LOCAL_DB_PORT}/postgres`,
            NEXT_TELEMETRY_DISABLED: "1",
          },
        },
      ],
});
