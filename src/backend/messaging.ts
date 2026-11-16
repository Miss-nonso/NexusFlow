import { Kafka, logLevel, type Consumer, type Producer } from "kafkajs";
import { database, transaction, type DB } from "./db";
import { dlqTopic, role, topic } from "./config";
import {
  envelopeSchema,
  subscriptions,
  event,
  enqueue,
  type Event,
} from "./events";
import { logger, traced } from "./telemetry";
export const kafka = () =>
  new Kafka({
    clientId: `nexusflow-${role()}`,
    brokers: (process.env.KAFKA_BROKERS || "kafka:9092").split(","),
    logLevel: logLevel.ERROR,
    ssl: process.env.KAFKA_TLS === "true",
    ...(process.env.KAFKA_USERNAME
      ? {
          sasl: {
            mechanism: "plain" as const,
            username: process.env.KAFKA_USERNAME,
            password: process.env.KAFKA_PASSWORD || "",
          },
        }
      : {}),
    retry: { retries: 8, initialRetryTime: 300 },
  });
export async function provisionTopics() {
  const admin = kafka().admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [topic, dlqTopic].map((t) => ({
        topic: t,
        numPartitions: 6,
        replicationFactor: Number(process.env.KAFKA_REPLICATION_FACTOR || 1),
      })),
    });
  } finally {
    await admin.disconnect();
  }
}
export async function startConsumer(): Promise<Consumer> {
  const consumer = kafka().consumer({
    groupId: `nexusflow-${role()}-v1`,
    sessionTimeout: 30000,
  });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    partitionsConsumedConcurrently: 3,
    eachMessage: async ({ topic: receivedTopic, partition, message }) => {
      let e: Event;
      try {
        e = envelopeSchema.parse(JSON.parse(message.value?.toString() || ""));
        if (message.key?.toString() !== e.orderId)
          throw new Error("Partition key mismatch");
      } catch {
        await database().query(
          "INSERT INTO poison_messages(topic,partition,offset_value,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [
            receivedTopic,
            partition,
            message.offset,
            "Invalid event envelope or partition key",
          ],
        );
        logger.warn(
          { partition, offset: message.offset },
          "Invalid Kafka event quarantined",
        );
        return;
      }
      if (!subscriptions[role()].includes(e.type)) return;
      if (e.type === "RetryDelivery" && e.data.service !== role()) return;
      // Commit the Kafka offset only after PostgreSQL has durably accepted the delivery.
      await database().query(
        "INSERT INTO inbox(id,aggregate_id,event) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [e.id, e.orderId, JSON.stringify(e)],
      );
    },
  });
  return consumer;
}
export async function publishOutbox(producer: Pick<Producer, "send">) {
  return transaction(async (db) => {
    // One relay per database preserves sequence across replicas; a crash may replay, never lose, a message.
    if (
      !(await db.query("SELECT pg_try_advisory_xact_lock(7913002) AS acquired"))
        .rows[0].acquired
    )
      return 0;
    const rows = (
      await db.query(
        "SELECT * FROM outbox WHERE published_at IS NULL ORDER BY sequence LIMIT 25 FOR UPDATE",
      )
    ).rows;
    for (const row of rows) {
      await producer.send({
        topic: row.topic,
        acks: -1,
        messages: [
          {
            key: row.aggregate_id,
            value: JSON.stringify(row.event),
            headers: row.event.traceparent
              ? { traceparent: row.event.traceparent }
              : {},
          },
        ],
      });
      await db.query("UPDATE outbox SET published_at=now() WHERE id=$1", [
        row.id,
      ]);
    }
    return rows.length;
  });
}
export async function deadLetter(db: DB, e: Event, errorCode: string) {
  await db.query("UPDATE inbox SET status='DEAD',last_error=$2 WHERE id=$1", [
    e.id,
    errorCode,
  ]);
  await db.query(
    "INSERT INTO dead_letters(id,event,error) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET error=EXCLUDED.error,replayed_at=NULL",
    [e.id, JSON.stringify(e), errorCode],
  );
  const failed = event(
    "WorkflowFailed",
    e.orderId,
    role(),
    { service: role(), jobId: e.id, eventType: e.type, error: errorCode },
    e.traceparent,
  );
  if (e.type !== "WorkflowFailed") await enqueue(db, failed);
  await enqueue(db, { ...failed, id: crypto.randomUUID() }, dlqTopic);
}
export async function processOne(
  handler: (db: DB, e: Event, replays: number) => Promise<void>,
): Promise<boolean> {
  return transaction(async (db) => {
    const result =
      await db.query(`SELECT i.* FROM inbox i WHERE i.status='PENDING' AND i.available_at<=now()
     AND NOT EXISTS(SELECT 1 FROM inbox older WHERE older.aggregate_id=i.aggregate_id AND older.status='PENDING' AND older.sequence<i.sequence)
     ORDER BY i.sequence LIMIT 1 FOR UPDATE OF i SKIP LOCKED`);
    const job = result.rows[0];
    if (!job) return false;
    const e = envelopeSchema.parse(job.event);
    await db.query("SAVEPOINT delivery");
    try {
      await traced(`consume.${e.type}`, e.traceparent, async () => {
        if (e.type === "RetryDelivery") {
          const original = (
            await db.query(
              "SELECT * FROM inbox WHERE id=$1 AND aggregate_id=$2 AND status='DEAD' FOR UPDATE",
              [e.data.jobId, e.orderId],
            )
          ).rows[0];
          if (original) {
            await db.query(
              "UPDATE inbox SET status='PENDING',attempts=0,manual_retries=manual_retries+1,available_at=now(),last_error=NULL WHERE id=$1",
              [original.id],
            );
            await db.query(
              "UPDATE dead_letters SET replayed_at=now() WHERE id=$1",
              [original.id],
            );
          }
        } else await handler(db, e, job.manual_retries);
      });
      await db.query(
        "UPDATE inbox SET status='DONE',completed_at=now(),last_error=NULL WHERE id=$1",
        [job.id],
      );
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT delivery");
      const attempts = job.attempts + 1;
      // Only a bounded, non-sensitive code is persisted; provider messages can contain PII.
      const code = error instanceof Error ? error.name : "ProcessingError";
      await db.query(
        "UPDATE inbox SET attempts=$2,last_error=$3,available_at=now()+($4*interval '1 second') WHERE id=$1",
        [job.id, attempts, code, Math.min(60, 2 ** attempts)],
      );
      if (attempts >= 3) await deadLetter(db, e, code);
      logger.warn(
        { eventId: e.id, orderId: e.orderId, attempts, code },
        "Delivery failed",
      );
    }
    return true;
  });
}
