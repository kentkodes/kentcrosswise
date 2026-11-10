import type { SqlClient } from "@kcw/db";
import { registerGutenbergSource } from "../../packages/essays/src/registry/bootstrap";

export interface RegisterReport {
  before: number;
  after: number;
  inserted: boolean;
}

const countSources = async (db: SqlClient): Promise<number> =>
  Number(((await db.query<{ n: string }>("SELECT count(*) AS n FROM sources")).rows[0] as { n: string }).n);

/** Registers the gutenberg source row if absent (never overwrites) and reports source counts. */
export async function runRegisterSource(db: SqlClient): Promise<RegisterReport> {
  const before = await countSources(db);
  const { inserted } = await registerGutenbergSource(db);
  return { before, after: await countSources(db), inserted };
}

export const formatRegister = (label: string, r: RegisterReport): string[] => [
  `${label}: sources before: ${r.before}`,
  `${label}: gutenberg source ${r.inserted ? "inserted" : "already present, unchanged"}`,
  `${label}: sources after: ${r.after}`,
];
