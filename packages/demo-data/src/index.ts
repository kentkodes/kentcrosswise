// @kcw/demo-data: the ONLY workspace data source public pages may import (D10).
// Everything is synthetic and deterministic.
import { generateDemoData, type DemoData } from "./generate";

/** Package name, used by the workspace smoke test. */
export const PACKAGE_NAME = "@kcw/demo-data";

export * from "./generate";
export { createRng, type Rng } from "./rng";

let cached: DemoData | undefined;

/** The default demo data set (seed DEMO_SEED), generated once per process. */
export function getDemoData(): DemoData {
  cached ??= generateDemoData();
  return cached;
}
