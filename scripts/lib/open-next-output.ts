// The OpenNext v4 output layout that infra/modules/web consumes (the "OpenNext output contract" in
// AGENTS.md). checkOpenNextOutput() fails the build if the layout drifts from what the module expects.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Paths relative to apps/web/.open-next. */
export const CONTRACT = {
  manifest: "open-next.output.json",
  server: { dir: "server-functions/default", entry: "server-functions/default/index.mjs", handler: "index.handler" },
  image: {
    dir: "image-optimization-function",
    entry: "image-optimization-function/index.mjs",
    handler: "index.handler",
    sharp: "image-optimization-function/node_modules/sharp/package.json",
  },
  revalidation: { dir: "revalidation-function", entry: "revalidation-function/index.mjs", handler: "index.handler" },
  assets: { dir: "assets", buildId: "assets/BUILD_ID", bucketPrefix: "_assets" },
  cache: { dir: "cache", bucketPrefix: "_cache" },
  overrides: { wrapper: "kcw-origin-guard", converter: "aws-apigw-v2", incrementalCache: "s3-lite", queue: "sqs-lite" },
} as const;

interface Origin {
  type?: string;
  bundle?: string;
  handler?: string;
  originPath?: string;
  wrapper?: string;
  converter?: string;
  incrementalCache?: string;
  queue?: string;
  copy?: { from?: string; to?: string }[];
}

interface Manifest {
  edgeFunctions?: Record<string, unknown>;
  origins?: Record<string, Origin>;
  behaviors?: { pattern?: string; origin?: string }[];
  additionalProps?: { revalidationFunction?: { bundle?: string; handler?: string } };
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** Returns a list of contract violations (empty = OK) and the build id if it could be read. */
export function checkOpenNextOutput(outDir: string): { problems: string[]; buildId?: string } {
  const problems: string[] = [];
  const at = (rel: string) => path.join(outDir, rel);
  const manifestPath = at(CONTRACT.manifest);
  if (!isFile(manifestPath)) return { problems: [`missing ${CONTRACT.manifest}`] };

  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return { problems: [`${CONTRACT.manifest} is not valid JSON`] };
  }

  const origins = m.origins ?? {};
  const names = Object.keys(origins).sort();
  if (names.join(",") !== "default,imageOptimizer,s3") {
    problems.push(`origins must be exactly default, imageOptimizer, s3 (got ${names.join(", ") || "none"}); function splitting needs a module change`);
  }
  if (Object.keys(m.edgeFunctions ?? {}).length > 0) problems.push("edge functions are not supported by infra/modules/web");

  const def = origins.default;
  if (def) {
    if (def.bundle !== `.open-next/${CONTRACT.server.dir}`) problems.push(`server bundle moved: ${def.bundle}`);
    if (def.handler !== CONTRACT.server.handler) problems.push(`server handler changed: ${def.handler}`);
    for (const [k, v] of Object.entries(CONTRACT.overrides)) {
      const got = (def as Record<string, unknown>)[k];
      if (got !== v) problems.push(`server override ${k} is ${String(got)}, expected ${v}`);
    }
  }
  const img = origins.imageOptimizer;
  if (img && (img.bundle !== `.open-next/${CONTRACT.image.dir}` || img.handler !== CONTRACT.image.handler)) {
    problems.push(`image optimizer bundle/handler changed: ${img.bundle} ${img.handler}`);
  }
  const s3 = origins.s3;
  if (s3) {
    if (s3.originPath !== CONTRACT.assets.bucketPrefix) problems.push(`s3 originPath changed: ${s3.originPath}`);
    const copies = (s3.copy ?? []).map((c) => `${c.from}->${c.to}`).sort();
    const want = [`.open-next/assets->${CONTRACT.assets.bucketPrefix}`, `.open-next/cache->${CONTRACT.cache.bucketPrefix}`];
    if (copies.join(",") !== want.join(",")) problems.push(`s3 copy list changed: ${copies.join(", ")}`);
  }
  const reval = m.additionalProps?.revalidationFunction;
  if (reval?.bundle !== `.open-next/${CONTRACT.revalidation.dir}`) {
    problems.push(`revalidation function bundle changed: ${String(reval?.bundle)}`);
  }

  for (const rel of [CONTRACT.server.entry, CONTRACT.image.entry, CONTRACT.revalidation.entry, CONTRACT.assets.buildId]) {
    if (!isFile(at(rel))) problems.push(`missing ${rel}`);
  }
  if (!isFile(at(CONTRACT.image.sharp))) problems.push(`missing ${CONTRACT.image.sharp} (sharp not installed)`);

  let buildId: string | undefined;
  if (isFile(at(CONTRACT.assets.buildId))) {
    buildId = readFileSync(at(CONTRACT.assets.buildId), "utf8").trim();
    if (!isDir(at(path.join(CONTRACT.cache.dir, buildId)))) problems.push(`missing ${CONTRACT.cache.dir}/${buildId}/`);
  }
  return { problems, buildId };
}
