import pg from "pg";
import { required } from "./config";
const pools = new Map<string, pg.Pool>();
function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.NODE_ENV === "production") return required("DATABASE_URL");
  return `postgresql://nexusflow:${encodeURIComponent(required("ORDER_DB_PASSWORD"))}@127.0.0.1:5433/nexusflow`;
}
export function database(url = connectionString()): pg.Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 30000,
      application_name: `nexusflow-${process.env.SERVICE_ROLE || "web"}`,
    });
    pool.on("error", () => console.error("PostgreSQL pool connection error"));
    pools.set(url, pool);
  }
  return pool;
}
export type DB = pg.PoolClient;
export async function transaction<T>(
  fn: (db: DB) => Promise<T>,
  pool = database(),
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function closeDatabases() {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
