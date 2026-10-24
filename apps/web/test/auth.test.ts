import { createFakeSecrets } from "@kcw/secrets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedSignIn, isOwnerEmail } from "../src/auth/allowlist";
import { authErrorType, buildAuthConfig, GOOGLE_SIGN_IN_SCOPES, googleProvider } from "../src/auth/config";
import { loadPreviewModule, parseKcwEnv } from "../src/auth/env";
import {
  checkPreviewToken,
  derivePreviewAuthSecret,
  loadPreviewSettings,
  PREVIEW_OWNER_EMAIL,
  PREVIEW_PROVIDER_ID,
} from "../src/auth/preview-login";
import { loadProdSettings } from "../src/auth/settings";
import { PREVIEW_MARKERS } from "../../../scripts/lib/bundle-check";

const OWNER = "owner@example.com";
const TOKEN = "synthetic-e2e-token-0123456789";

describe("allowlist", () => {
  it("matches the owner email case-insensitively and trimmed", () => {
    expect(isOwnerEmail("Owner@Example.com ", OWNER)).toBe(true);
    expect(isOwnerEmail(OWNER, " OWNER@example.com")).toBe(true);
  });

  it("rejects other, empty and missing emails, and a blank owner", () => {
    expect(isOwnerEmail("someone@example.com", OWNER)).toBe(false);
    expect(isOwnerEmail("owner@example.com.evil.invalid", OWNER)).toBe(false);
    expect(isOwnerEmail("", OWNER)).toBe(false);
    expect(isOwnerEmail(undefined, OWNER)).toBe(false);
    expect(isOwnerEmail(null, OWNER)).toBe(false);
    expect(isOwnerEmail("", "")).toBe(false);
    expect(isOwnerEmail("x", "x")).toBe(false);
  });

  it("Google: requires a verified owner email", () => {
    expect(isAllowedSignIn({ provider: "google", email: OWNER, emailVerified: true }, OWNER)).toBe(true);
    expect(isAllowedSignIn({ provider: "google", email: OWNER, emailVerified: false }, OWNER)).toBe(false);
    expect(isAllowedSignIn({ provider: "google", email: OWNER }, OWNER)).toBe(false);
    expect(isAllowedSignIn({ provider: "google", email: OWNER, emailVerified: "true" }, OWNER)).toBe(false);
    expect(
      isAllowedSignIn({ provider: "google", email: "other@example.com", emailVerified: true }, OWNER),
    ).toBe(false);
  });

  it("the preview provider counts only when the build passes its id", () => {
    const attempt = { provider: PREVIEW_PROVIDER_ID, email: PREVIEW_OWNER_EMAIL };
    expect(isAllowedSignIn(attempt, PREVIEW_OWNER_EMAIL)).toBe(false);
    expect(isAllowedSignIn(attempt, PREVIEW_OWNER_EMAIL, PREVIEW_PROVIDER_ID)).toBe(true);
    expect(isAllowedSignIn({ provider: "github", email: OWNER }, OWNER, PREVIEW_PROVIDER_ID)).toBe(false);
    expect(isAllowedSignIn({ provider: undefined, email: OWNER }, OWNER)).toBe(false);
  });
});

describe("build flag", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses KCW_ENV, defaulting to prod", () => {
    expect(parseKcwEnv(undefined)).toBe("prod");
    expect(parseKcwEnv("")).toBe("prod");
    expect(parseKcwEnv("prod")).toBe("prod");
    expect(parseKcwEnv("preview")).toBe("preview");
    expect(() => parseKcwEnv("Preview")).toThrow(/KCW_ENV/);
    expect(() => parseKcwEnv("dev")).toThrow(/KCW_ENV/);
  });

  it("loads the preview module only when KCW_ENV=preview", async () => {
    vi.stubEnv("KCW_ENV", "");
    expect(await loadPreviewModule()).toBeUndefined();
    vi.stubEnv("KCW_ENV", "prod");
    expect(await loadPreviewModule()).toBeUndefined();
    vi.stubEnv("KCW_ENV", "preview");
    const mod = await loadPreviewModule();
    expect(mod?.PREVIEW_PROVIDER_ID).toBe(PREVIEW_PROVIDER_ID);
  });

  it("the bundle check looks for the preview provider's markers", () => {
    expect(PREVIEW_MARKERS).toContain(PREVIEW_PROVIDER_ID);
    expect(PREVIEW_MARKERS).toContain(PREVIEW_OWNER_EMAIL);
  });
});

describe("settings", () => {
  const web = {
    auth_secret: "a".repeat(40),
    owner_email: OWNER,
    google_client_id: "client-id.apps.example.invalid",
    google_client_secret: "synthetic-client-secret",
  };

  it("prod reads kcw/prod/web by default, or the name in KCW_WEB_SECRET", async () => {
    const { store, aws } = createFakeSecrets({ "kcw/prod/web": web, "kcw/other/web": web });
    const s = await loadProdSettings({}, store);
    expect(s).toEqual({
      authSecret: web.auth_secret,
      ownerEmail: OWNER,
      google: { clientId: web.google_client_id, clientSecret: web.google_client_secret },
    });
    await loadProdSettings({ KCW_WEB_SECRET: "kcw/other/web" }, store);
    expect(new Set(aws.calls.map((c) => c.name))).toEqual(new Set(["kcw/prod/web", "kcw/other/web"]));
  });

  it("prod rejects a short auth secret or a bad owner email", async () => {
    const short = createFakeSecrets({ "kcw/prod/web": { ...web, auth_secret: "short" } });
    await expect(loadProdSettings({}, short.store)).rejects.toThrow(/auth_secret/);
    const bad = createFakeSecrets({ "kcw/prod/web": { ...web, owner_email: "nobody" } });
    await expect(loadProdSettings({}, bad.store)).rejects.toThrow(/owner_email/);
  });

  it("prod fails when a key is missing", async () => {
    const { store } = createFakeSecrets({ "kcw/prod/web": { auth_secret: web.auth_secret } });
    await expect(loadProdSettings({}, store)).rejects.toThrow(/owner_email|google/);
  });

  it("preview reads e2e_login from kcw/ci, or KCW_E2E_LOGIN locally", async () => {
    const { store, aws } = createFakeSecrets({ "kcw/ci": { e2e_login: TOKEN, neon_api_key: "x" } });
    const fromSecret = await loadPreviewSettings({}, store);
    expect(fromSecret).toEqual({
      authSecret: derivePreviewAuthSecret(TOKEN),
      ownerEmail: PREVIEW_OWNER_EMAIL,
      e2eLogin: TOKEN,
    });
    const before = aws.calls.length;
    const local = await loadPreviewSettings({ KCW_E2E_LOGIN: `${TOKEN}-local` }, store);
    expect(local.e2eLogin).toBe(`${TOKEN}-local`);
    expect(aws.calls.length).toBe(before);
  });

  it("preview rejects a short token", async () => {
    const { store } = createFakeSecrets({});
    await expect(loadPreviewSettings({ KCW_E2E_LOGIN: "short" }, store)).rejects.toThrow(/at least/);
  });
});

describe("preview login", () => {
  it("compares tokens exactly", () => {
    expect(checkPreviewToken(TOKEN, TOKEN)).toBe(true);
    expect(checkPreviewToken(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(checkPreviewToken("", TOKEN)).toBe(false);
    expect(checkPreviewToken(undefined, TOKEN)).toBe(false);
    expect(checkPreviewToken(["x"], TOKEN)).toBe(false);
    expect(checkPreviewToken("short", "short")).toBe(false);
  });

  it("derives a stable, token-specific auth secret", () => {
    const a = derivePreviewAuthSecret(TOKEN);
    expect(a).toBe(derivePreviewAuthSecret(TOKEN));
    expect(a).not.toBe(derivePreviewAuthSecret(`${TOKEN}2`));
    expect(a).not.toContain(TOKEN);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });
});

describe("Auth.js config", () => {
  const settings = { authSecret: "s".repeat(40), ownerEmail: OWNER };
  const signIn = (previewId?: string) => {
    const cfg = buildAuthConfig(settings, [], previewId);
    expect(cfg.session?.strategy).toBe("jwt");
    expect(cfg.trustHost).toBe(true);
    return cfg.callbacks!.signIn! as (p: unknown) => boolean;
  };

  it("the signIn callback applies the allowlist", () => {
    const cb = signIn();
    const google = { provider: "google", type: "oidc", providerAccountId: "1" };
    expect(cb({ account: google, profile: { email: OWNER, email_verified: true }, user: {} })).toBe(true);
    expect(cb({ account: google, profile: { email: "x@example.com", email_verified: true }, user: {} })).toBe(false);
    expect(cb({ account: google, profile: { email: OWNER, email_verified: false }, user: {} })).toBe(false);
    const creds = { provider: PREVIEW_PROVIDER_ID, type: "credentials", providerAccountId: "p" };
    expect(cb({ account: creds, user: { email: OWNER } })).toBe(false);
    expect(signIn(PREVIEW_PROVIDER_ID)({ account: creds, user: { email: OWNER } })).toBe(true);
  });

  it("logs only the Auth.js error type", () => {
    const err = Object.assign(new Error("token owner@example.com"), { type: "CredentialsSignin" });
    expect(authErrorType(err)).toBe("CredentialsSignin");
    expect(authErrorType(new Error("secret detail"))).toBe("Error");
  });

  it("asks Google for sign-in scopes only", () => {
    expect(GOOGLE_SIGN_IN_SCOPES.split(" ").sort()).toEqual(["email", "openid", "profile"]);
    const google = googleProvider({
      ...settings,
      google: { clientId: "id.apps.example.invalid", clientSecret: "synthetic" },
    }) as { id: string; options?: { authorization?: { params?: { scope?: string } } } };
    expect(google.id).toBe("google");
    expect(google.options?.authorization?.params?.scope).toBe(GOOGLE_SIGN_IN_SCOPES);
    expect(() => googleProvider(settings)).toThrow(/Google client/);
  });
});
