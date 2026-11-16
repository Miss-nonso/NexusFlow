import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { database, transaction, type DB } from "./db";
import { event, enqueue, itemSchema } from "./events";
import { HttpError } from "./auth";
import { internal } from "./internal";
import { redis } from "./redis";
import { currentTrace } from "./telemetry";
export const orderInput = z
  .object({
    customer: z.string().trim().min(1).max(120),
    email: z.email().max(254),
    items: z
      .array(itemSchema.pick({ sku: true, quantity: true }).strict())
      .min(1)
      .max(20),
    fault: z.enum(["none", "payment", "fulfillment"]).default("none"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.items.map((i) => i.sku)).size !== v.items.length)
      ctx.addIssue({
        code: "custom",
        message: "Each SKU may appear only once",
      });
  });
export function canonicalRequest(input: z.infer<typeof orderInput>) {
  return {
    ...input,
    items: [...input.items].sort((a, b) => a.sku.localeCompare(b.sku)),
  };
}
export function fingerprint(input: z.infer<typeof orderInput>) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalRequest(input)))
    .digest("hex");
}
export async function createOrder(input: unknown, key: string) {
  const parsed = orderInput.parse(input),
    hash = fingerprint(parsed);
  z.uuid().parse(key);
  if (parsed.fault !== "none" && process.env.ALLOW_FAULT_INJECTION !== "true")
    throw new HttpError(403, "Fault injection is disabled");
  if (parsed.fault === "payment" && process.env.PAYMENT_PROVIDER === "stripe")
    throw new HttpError(400, "Use a Stripe test card to test declines");
  const cached = await redis()
    .get(`idempotency:${key}`)
    .catch(() => null);
  if (cached) {
    const value = JSON.parse(cached);
    if (value.hash !== hash)
      throw new HttpError(
        409,
        "Idempotency key was used for a different request",
      );
    return { id: value.id, replayed: true };
  }
  const existing = (
    await database().query(
      "SELECT id,request_hash FROM orders WHERE idempotency_key=$1",
      [key],
    )
  ).rows[0];
  if (existing) {
    if (existing.request_hash !== hash)
      throw new HttpError(
        409,
        "Idempotency key was used for a different request",
      );
    return { id: existing.id, replayed: true };
  }
  const stock = (await internal("inventory", "/inventory")) as {
    sku: string;
    price: number;
  }[];
  const items = canonicalRequest(parsed).items.map((item) => {
    const sku = stock.find((s) => s.sku === item.sku);
    if (!sku) throw new HttpError(400, `Unknown SKU: ${item.sku}`);
    return { ...item, unitPrice: sku.price };
  });
  const amount = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000)
    throw new HttpError(400, "Order amount is outside the supported range");
  const result = await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      key,
    ]);
    const duplicate = (
      await db.query(
        "SELECT id,request_hash FROM orders WHERE idempotency_key=$1",
        [key],
      )
    ).rows[0];
    if (duplicate) {
      if (duplicate.request_hash !== hash)
        throw new HttpError(
          409,
          "Idempotency key was used for a different request",
        );
      return { id: duplicate.id, replayed: true };
    }
    const id = randomUUID();
    await db.query(
      "INSERT INTO orders(id,idempotency_key,request_hash,customer,email,items,amount,currency,status,stage,fault) VALUES($1,$2,$3,$4,$5,$6,$7,'usd','PROCESSING','CREATED',$8)",
      [
        id,
        key,
        hash,
        parsed.customer,
        parsed.email,
        JSON.stringify(items),
        amount,
        parsed.fault,
      ],
    );
    await enqueue(db, event("OrderCreated", id, "order", {}, currentTrace()));
    return { id, replayed: false };
  });
  // Redis is a disposable response cache; the database remains authoritative if it is lost.
  await redis()
    .set(`idempotency:${key}`, JSON.stringify({ hash, ...result }), "EX", 86400)
    .catch(() => {});
  return result;
}
export async function retryOrder(id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    const order = (
      await db.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!order) throw new HttpError(404, "Order not found");
    if (order.status !== "DEAD_LETTER" || !order.failure?.jobId)
      throw new HttpError(409, "Order has no retryable dead-letter delivery");
    await enqueue(
      db,
      event(
        "RetryDelivery",
        id,
        "order",
        { service: order.failure.service, jobId: order.failure.jobId },
        currentTrace(),
      ),
    );
    await db.query(
      "UPDATE orders SET status=$2,failure=NULL,updated_at=now(),version=version+1 WHERE id=$1",
      [
        id,
        order.failure.resumeStatus === "DEAD_LETTER"
          ? "PROCESSING"
          : order.failure.resumeStatus,
      ],
    );
    return { id };
  });
}
export async function refundOrder(id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    const order = (
      await db.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!order) throw new HttpError(404, "Order not found");
    if (["REFUNDING", "REFUNDED"].includes(order.status))
      return { id, replayed: true };
    if (order.status !== "FULFILLED")
      throw new HttpError(409, "Only fulfilled orders can be refunded");
    await enqueue(db, event("RefundPayment", id, "order", {}, currentTrace()));
    await db.query(
      "UPDATE orders SET status='REFUNDING',stage='REFUNDING',updated_at=now(),completed_at=NULL,version=version+1 WHERE id=$1",
      [id],
    );
    return { id, replayed: false };
  });
}
export function presentOrder(row: Record<string, any>) {
  return {
    id: row.id,
    key: row.idempotency_key,
    customer: row.customer,
    email: row.email,
    items: row.items,
    sku: row.items.map((i: any) => i.sku).join(", "),
    quantity: row.items.reduce((sum: number, i: any) => sum + i.quantity, 0),
    amount: row.amount,
    status: row.status,
    stage: row.stage,
    fault: row.fault,
    created: new Date(row.created_at).getTime(),
    duration: row.completed_at
      ? new Date(row.completed_at).getTime() -
        new Date(row.created_at).getTime()
      : Date.now() - new Date(row.created_at).getTime(),
    events: row.events || [],
    failure: row.failure,
  };
}
export async function getOrder(id: string) {
  z.uuid().parse(id);
  const result = await database().query(
    `SELECT o.*,coalesce((SELECT jsonb_agg(jsonb_build_object('name',name,'service',service,'time',extract(epoch from occurred_at)*1000,'payload',payload) ORDER BY sequence) FROM order_events WHERE order_id=o.id),'[]') AS events FROM orders o WHERE id=$1`,
    [id],
  );
  if (!result.rowCount) throw new HttpError(404, "Order not found");
  return presentOrder(result.rows[0]);
}
export async function snapshot(hours = 1) {
  const pool = database();
  const [orders, totals, buckets, stock, heartbeats] = await Promise.all([
    pool.query(
      `SELECT o.*,coalesce((SELECT jsonb_agg(jsonb_build_object('name',name,'service',service,'time',extract(epoch from occurred_at)*1000) ORDER BY sequence) FROM order_events WHERE order_id=o.id),'[]') AS events FROM orders o ORDER BY created_at DESC LIMIT 200`,
    ),
    pool.query(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE status='FULFILLED')::int AS fulfilled,count(*) FILTER(WHERE status='CANCELLED')::int AS cancelled,count(*) FILTER(WHERE status='DEAD_LETTER')::int AS dead,count(*) FILTER(WHERE status IN ('PROCESSING','PAYMENT_PENDING','CANCELLING','REFUNDING'))::int AS processing,count(*) FILTER(WHERE status='REFUNDED')::int AS refunded,coalesce(sum(amount) FILTER(WHERE status='FULFILLED'),0)::float AS revenue,coalesce(avg(extract(epoch from fulfilled_at-created_at)*1000) FILTER(WHERE fulfilled_at IS NOT NULL),0)::float AS latency FROM orders`,
    ),
    pool.query(
      `WITH buckets AS (SELECT generate_series(0,47) AS n) SELECT n,(SELECT count(*)::int FROM orders WHERE created_at>=now()-($1*interval '1 hour')+(n*$1*interval '1 hour'/48) AND created_at<now()-($1*interval '1 hour')+((n+1)*$1*interval '1 hour'/48)) AS value FROM buckets ORDER BY n`,
      [hours],
    ),
    internal("inventory", "/inventory").catch(() => null),
    redis()
      .mget(
        "heartbeat:order",
        "heartbeat:inventory",
        "heartbeat:payment",
        "heartbeat:fulfillment",
      )
      .catch(() => [null, null, null, null]),
  ]);
  const services = ["order", "inventory", "payment", "fulfillment"].map(
    (name, i) => ({
      name,
      healthy: !!heartbeats[i] && Date.now() - Number(heartbeats[i]) < 30000,
    }),
  );
  return {
    orders: orders.rows.map(presentOrder),
    stock: stock || [],
    totals: totals.rows[0],
    series: buckets.rows.map((r) => r.value),
    services,
    inventoryAvailable: stock !== null,
    provider: process.env.PAYMENT_PROVIDER || "mock",
    faultInjection: process.env.ALLOW_FAULT_INJECTION === "true",
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
    time: Date.now(),
  };
}
