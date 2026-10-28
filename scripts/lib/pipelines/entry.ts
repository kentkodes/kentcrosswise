import { Client } from "pg";
import { getSecret } from "@kcw/secrets";
import { createAwsAdapters } from "./aws";
import { createPipelineHandler } from "./handler";

export const handler = createPipelineHandler({
  env: process.env,
  secret: async (name, key) => {
    const value = key === undefined ? await getSecret(name) : await getSecret(name, key);
    if (typeof value !== "string") throw new Error("database_secret_invalid");
    return value;
  },
  async connect(url) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
    try { await client.connect(); } catch (error) { await client.end(); throw error; }
    return {
      query: async <R>(sql: string, params?: readonly unknown[]) => {
        const result = await client.query(sql, params ? [...params] : undefined);
        return { rows: result.rows as R[] };
      },
      close: () => client.end(),
    };
  },
  adapters: createAwsAdapters,
  log: (entry) => console.log(JSON.stringify(entry)),
});
