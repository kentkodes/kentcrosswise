// Fixture for test/eslint-public-imports.test.ts: a public page that wrongly imports private code.
import { migrate } from "@kcw/db";
import { getSecret } from "@kcw/secrets";
import pg from "pg";
import { getDemoData } from "@kcw/demo-data";

export default function Bad() {
  return <pre>{String([migrate, getSecret, pg, getDemoData])}</pre>;
}
