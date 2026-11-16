import Redis from "ioredis";
import { required } from "./config";
let client: Redis | undefined;
function connectionUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  // `npm run dev` runs on the host, outside Compose's service DNS. Compose
  // publishes Redis on loopback for this development fallback.
  const password = encodeURIComponent(required("REDIS_PASSWORD"));
  const host = process.env.REDIS_HOST || "127.0.0.1";
  const port = process.env.REDIS_PORT || "6379";
  return `redis://:${password}@${host}:${port}`;
}
export function redis() {
  if (!client) {
    client = new Redis(connectionUrl(), {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      commandTimeout: 3000,
    });
    client.on("error", () => {}); // Health endpoints report failures; never log credentials.
  }
  return client;
}
export async function limit(key: string, max: number, seconds: number) {
  const count = await redis().eval(
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
    1,
    `rate:${key}`,
    seconds,
  );
  return Number(count) <= max;
}
export async function closeRedis() {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
