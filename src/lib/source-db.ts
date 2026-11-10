import "server-only";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.NZMARIE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("NZMARIE_DATABASE_URL is not configured.");
  }

  const sourceUrl = new URL(connectionString);
  if (sourceUrl.protocol !== "postgres:" && sourceUrl.protocol !== "postgresql:") {
    throw new Error("NZMARIE_DATABASE_URL must use PostgreSQL.");
  }

  const sslMode = sourceUrl.searchParams.get("sslmode")?.toLowerCase();
  if (sslMode === "disable") {
    throw new Error("The source database connection must use verified TLS.");
  }

  const configuredCaPath =
    process.env.NZMARIE_SSL_CA?.trim() ||
    (sourceUrl.searchParams.get("sslrootcert") &&
    sourceUrl.searchParams.get("sslrootcert") !== "system"
      ? sourceUrl.searchParams.get("sslrootcert")
      : undefined);

  sourceUrl.searchParams.delete("sslmode");
  sourceUrl.searchParams.delete("sslrootcert");

  const ca = configuredCaPath ? readFileSync(configuredCaPath, "utf8") : undefined;
  const nextPool = new Pool({
    connectionString: sourceUrl.toString(),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: 4,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 8_000,
    application_name: "smartroute-outreach-map-readonly",
  });
  nextPool.on("error", (error) => {
    console.error("Idle source database connection failed.", {
      name: error.name,
    });
  });
  pool = nextPool;

  return pool;
}

export async function withReadOnlyTransaction<T>(
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN READ ONLY");
    const result = await action(client);
    await client.query("COMMIT");
    committed = true;
    return result;
  } finally {
    client.release(!committed);
  }
}
