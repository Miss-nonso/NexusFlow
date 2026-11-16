import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { database, transaction } from "./db";
import { role } from "./config";
export async function migrate(service = role(), url?: string) {
  const pool = database(url);
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(7913001)");
    await db.query(await readFile(resolve("migrations/common.sql"), "utf8"));
    const version = `001-${service}`;
    if (
      (
        await db.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
          version,
        ])
      ).rowCount
    )
      return;
    await db.query(
      await readFile(resolve(`migrations/${service}.sql`), "utf8"),
    );
    await db.query("INSERT INTO schema_migrations(version) VALUES($1)", [
      version,
    ]);
  }, pool);
}
