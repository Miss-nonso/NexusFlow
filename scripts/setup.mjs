import { randomBytes } from "node:crypto";
import { writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const target = fileURLToPath(new URL("../.env", import.meta.url));
try {
  await access(target);
  console.log(".env already exists; preserved.");
  process.exit(0);
} catch {}
const secret = () => randomBytes(32).toString("hex");
await writeFile(
  target,
  `# Generated local credentials. Do not commit.\nAPP_ORIGIN=http://localhost:8080\nAPP_PORT=8080\nADMIN_PASSWORD=${secret()}\nADMIN_API_TOKEN=${secret()}\nSESSION_SECRET=${secret()}\nINTERNAL_TOKEN=${secret()}\nDB_ADMIN_PASSWORD=${secret()}\nORDER_DB_PASSWORD=${secret()}\nINVENTORY_DB_PASSWORD=${secret()}\nPAYMENT_DB_PASSWORD=${secret()}\nFULFILLMENT_DB_PASSWORD=${secret()}\nREDIS_PASSWORD=${secret()}\nPAYMENT_PROVIDER=mock\nALLOW_FAULT_INJECTION=false\nALLOW_LIVE_PAYMENTS=false\nSECURE_COOKIES=false\nSTRIPE_SECRET_KEY=\nSTRIPE_PUBLISHABLE_KEY=\nSTRIPE_WEBHOOK_SECRET=\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  `Created ${target}. Read ADMIN_PASSWORD there to sign in. No credentials were printed.`,
);
