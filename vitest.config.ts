import { defineConfig } from "vitest/config";

// One Vitest run for the whole monorepo: every workspace package is a project.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "agents/*", "scripts"],
  },
});
