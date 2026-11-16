import { migrate } from "./migrate";
import { closeDatabases } from "./db";
import { roles } from "./config";
try {
  if (process.env.MIGRATE_ALL === "true") {
    for (const service of roles) {
      const url = process.env[`${service.toUpperCase()}_DATABASE_URL`];
      if (!url) throw new Error(`Missing database URL for ${service}`);
      await migrate(service, url);
    }
  } else await migrate();
  console.log("Migrations applied");
} finally {
  await closeDatabases();
}
