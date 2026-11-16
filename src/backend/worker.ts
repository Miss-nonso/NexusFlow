import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { database, closeDatabases } from "./db";
import { closeRedis, redis } from "./redis";
import { required, role, validateSecrets } from "./config";
import { constantEqual } from "./auth";
import {
  kafka,
  provisionTopics,
  publishOutbox,
  processOne,
  startConsumer,
} from "./messaging";
import { orchestrate } from "./orchestrator";
import { inventory } from "./inventory";
import { fulfill } from "./fulfillment";
import { payment, reconcilePayments, webhook } from "./payments";
import { migrate } from "./migrate";
import { logger } from "./telemetry";
import { startTelemetry, stopTelemetry } from "./otel";
import type { DB } from "./db";
import type { Event } from "./events";
validateSecrets(true);
startTelemetry();
const service = role();
await migrate();
await provisionTopics();
const producer = kafka().producer({ idempotent: true, maxInFlightRequests: 1 });
await producer.connect();
const admin = kafka().admin();
await admin.connect();
const consumer = await startConsumer();
let running = true,
  busHealthy = true,
  consumerHealthy = true,
  shutdownStarted = false;
let consumerLag = 0;
consumer.on(consumer.events.CRASH, () => {
  consumerHealthy = false;
});
consumer.on(consumer.events.GROUP_JOIN, () => {
  consumerHealthy = true;
});
const handler: Record<
  string,
  (db: DB, e: Event, replays: number) => Promise<void>
> = { order: orchestrate, inventory, payment, fulfillment: fulfill };
const server = createServer(async (req, res) => {
  const json = (status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  try {
    if (req.url === "/health") {
      await Promise.all([database().query("SELECT 1"), redis().ping()]);
      json(busHealthy && consumerHealthy && running ? 200 : 503, {
        service,
        ready: busHealthy && consumerHealthy && running,
      });
      return;
    }
    if (req.url === "/metrics") {
      const data = (
        await database().query(
          `SELECT (SELECT count(*) FROM outbox WHERE published_at IS NULL)::int AS outbox,(SELECT count(*) FROM inbox WHERE status='PENDING')::int AS pending,(SELECT count(*) FROM inbox WHERE status='DEAD')::int AS dead,(SELECT count(*) FROM inbox WHERE status='DONE')::int AS processed,(SELECT count(*) FROM poison_messages)::int AS poison`,
        )
      ).rows[0];
      let latencyMetrics = "";
      if (service === "order") {
        const boundaries = [0.5, 1, 2, 5, 10, 30, 60, 300, 3600];
        const values = (
          await database().query(
            `SELECT count(*)::int AS count,coalesce(sum(duration),0)::float AS sum,${boundaries.map((bound, i) => `count(*) FILTER(WHERE duration<=${bound})::int AS b${i}`).join(",")} FROM (SELECT extract(epoch from fulfilled_at-created_at) AS duration FROM orders WHERE fulfilled_at IS NOT NULL) elapsed`,
          )
        ).rows[0];
        latencyMetrics =
          "# TYPE nexusflow_order_duration_seconds histogram\n" +
          boundaries
            .map(
              (bound, i) =>
                `nexusflow_order_duration_seconds_bucket{le="${bound}"} ${values[`b${i}`]}`,
            )
            .join("\n") +
          `\nnexusflow_order_duration_seconds_bucket{le="+Inf"} ${values.count}\nnexusflow_order_duration_seconds_count ${values.count}\nnexusflow_order_duration_seconds_sum ${values.sum}\n`;
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(
        Object.entries({ ...data, consumer_lag: consumerLag })
          .map(
            ([key, value]) =>
              `# TYPE nexusflow_${key} gauge\nnexusflow_${key}{service="${service}"} ${value}`,
          )
          .join("\n") +
          "\n" +
          latencyMetrics,
      );
      return;
    }
    if (
      !constantEqual(
        String(req.headers["x-internal-token"] || ""),
        required("INTERNAL_TOKEN"),
      )
    ) {
      json(401, { error: "Unauthorized" });
      return;
    }
    if (
      service === "inventory" &&
      req.url === "/inventory" &&
      req.method === "GET"
    ) {
      json(
        200,
        (
          await database().query(
            "SELECT sku,name,price,available,reserved,version FROM inventory ORDER BY sku",
          )
        ).rows,
      );
      return;
    }
    if (
      service === "payment" &&
      req.url?.match(/^\/payments\/[0-9a-f-]{36}$/i) &&
      req.method === "GET"
    ) {
      const result = await database().query(
        'SELECT status,provider,client_secret AS "clientSecret",expires_at AS "expiresAt" FROM payments WHERE order_id=$1',
        [req.url.split("/")[2]],
      );
      json(
        result.rowCount ? 200 : 404,
        result.rows[0] || { error: "Payment not found" },
      );
      return;
    }
    if (
      service === "payment" &&
      req.url === "/stripe/webhook" &&
      req.method === "POST"
    ) {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 262144) {
          json(413, { error: "Body too large" });
          return;
        }
        chunks.push(chunk);
      }
      try {
        await webhook(
          Buffer.concat(chunks),
          String(req.headers["stripe-signature"] || ""),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "StripeSignatureVerificationError"
        ) {
          json(400, { error: "Invalid signature" });
          return;
        }
        throw error;
      }
      json(200, { received: true });
      return;
    }
    json(404, { error: "Not found" });
  } catch (error) {
    logger.error(
      { errorType: error instanceof Error ? error.name : "Error" },
      "Internal request failed",
    );
    json(503, { error: "Service temporarily unavailable" });
  }
});
server.requestTimeout = 30000;
server.listen(Number(process.env.PORT || 4000), "0.0.0.0");
async function loop(
  name: string,
  interval: number,
  fn: () => Promise<unknown>,
) {
  while (running) {
    try {
      await fn();
    } catch (error) {
      logger.error(
        {
          operation: name,
          errorType: error instanceof Error ? error.name : "Error",
        },
        "Worker operation failed",
      );
    }
    if (running) await sleep(interval);
  }
}
const loops = [
  loop("outbox", 250, () => publishOutbox(producer)),
  loop("deliveries", 100, async () => {
    for (let n = 0; n < 20 && running; n++)
      if (!(await processOne(handler[service]))) break;
  }),
  loop("heartbeat", 5000, async () => {
    try {
      await admin.fetchTopicMetadata();
      const groupId = `nexusflow-${service}-v1`;
      const [ends, groups] = await Promise.all([
        admin.fetchTopicOffsets(
          process.env.KAFKA_TOPIC || "nexusflow.events.v1",
        ),
        admin.fetchOffsets({
          groupId,
          topics: [process.env.KAFKA_TOPIC || "nexusflow.events.v1"],
        }),
      ]);
      const offsets = groups[0]?.partitions || [];
      consumerLag = ends.reduce((sum, end) => {
        const offset = offsets.find(
          (p) => p.partition === end.partition,
        )?.offset;
        return (
          sum +
          Math.max(0, Number(end.offset) - Math.max(0, Number(offset || 0)))
        );
      }, 0);
      busHealthy = true;
      await database().query("SELECT 1");
      if (consumerHealthy)
        await redis().set(`heartbeat:${service}`, String(Date.now()), "EX", 30);
    } catch (error) {
      busHealthy = false;
      throw error;
    }
  }),
  ...(service === "payment"
    ? [loop("reconciliation", 10000, reconcilePayments)]
    : []),
];
async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  running = false;
  const deadline = setTimeout(() => process.exit(1), 45000);
  deadline.unref();
  server.close();
  await consumer.stop();
  await Promise.all(loops);
  await Promise.all([
    consumer.disconnect(),
    producer.disconnect(),
    admin.disconnect(),
  ]);
  await closeRedis();
  await closeDatabases();
  await stopTelemetry();
  clearTimeout(deadline);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
logger.info({ service }, "Worker ready");
