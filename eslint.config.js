// @ts-check
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * D10: public pages may import only @kcw/demo-data and @kcw/xray from the workspace,
 * and nothing that reaches a database, a secret, a model or owner-only code.
 * Exported so the rule test can assert on the exact patterns.
 */
export const PUBLIC_IMPORT_PATTERNS = [
  {
    group: ["@kcw/*", "!@kcw/demo-data", "!@kcw/xray"],
    message: "Public pages may import only @kcw/demo-data and @kcw/xray from the workspace (D10).",
  },
  {
    group: ["pg", "kysely", "@electric-sql/*", "@aws-sdk/*", "@anthropic-ai/*", "@typesafe-ai/*"],
    message: "Public pages must not reach databases, secrets or models (D10).",
  },
  {
    group: ["@/server", "@/server/*", "**/server/**", "**/(owner)/**"],
    message: "Public pages must not import server-only or owner code (D10).",
  },
];

export const PUBLIC_FILES = ["apps/web/src/app/(public)/**/*.{ts,tsx,js,jsx,mjs}"];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-*/**",
      "**/.next/**",
      "**/.open-next/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "**/test/fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx,js,jsx,mjs}"],
    ...nextPlugin.configs.recommended,
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: "apps/web" } },
  },
  {
    files: PUBLIC_FILES,
    rules: {
      "no-restricted-imports": ["error", { patterns: PUBLIC_IMPORT_PATTERNS }],
    },
  },
);
