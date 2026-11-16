import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { database, closeDatabases, transaction } from "../../src/backend/db";
import { migrate } from "../../src/backend/migrate";
import { event, enqueue } from "../../src/backend/events";
import { publishOutbox, processOne } from "../../src/backend/messaging";
if (
  process.env.TEST_TARGET_APPROVED !== "true" ||
  process.env.PAYMENT_PROVIDER !== "mock"
)
  throw new Error(
    "Integration tests require an explicitly approved local mock-payment stack",
  );
const base = process.env.TEST_BASE_URL || "http://web:3000";
const token = process.env.ADMIN_API_TOKEN!;
const inventoryDb = database(process.env.INVENTORY_DATABASE_URL!);
const paymentDb = database(process.env.PAYMENT_DATABASE_URL!);
const fulfillmentDb = database(process.env.FULFILLMENT_DATABASE_URL!);
async function request(path: string, body?: unknown, key?: string) {
  const response = await fetch(`${base}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function waitOrder(id: string, statuses: string[], timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await request(`orders/${id}`);
    assert.equal(result.status, 200);
    if (statuses.includes(result.data.status)) return result.data;
    await sleep(300);
  }
  throw new Error(`Order ${id} did not reach ${statuses.join("/")}`);
}
async function product(available = 10) {
  const sku = `TEST-${randomUUID().slice(0, 8).toUpperCase()}`;
  await inventoryDb.query(
    "INSERT INTO inventory(sku,name,price,available) VALUES($1,$2,1500,$3)",
    [sku, "Integration fixture", available],
  );
  return sku;
}
const body = (sku: string, fault = "none", quantity = 1) => ({
  customer: "Integration test",
  email: "integration@example.test",
  items: [{ sku, quantity }],
  fault,
});
test("unauthenticated access cannot read orders", async () => {
  const r = await fetch(`${base}/api/state`);
  assert.equal(r.status, 401);
});
test("concurrent idempotent requests create one persisted order, charge and shipment", async () => {
  const sku = await product(),
    key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => request("orders", body(sku), key)),
  );
  assert.ok(
    results.every((r) => [200, 202].includes(r.status)),
    JSON.stringify(results),
  );
  const ids = new Set(results.map((r) => r.data.id));
  assert.equal(ids.size, 1);
  const id = results[0].data.id;
  const complete = await waitOrder(id, ["FULFILLED"]);
  assert.equal(complete.amount, 1500);
  assert.equal(
    (
      await paymentDb.query(
        "SELECT count(*)::int AS n FROM payment_ledger WHERE order_id=$1 AND kind='CAPTURED'",
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await fulfillmentDb.query(
        "SELECT count(*)::int AS n FROM shipments WHERE order_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await request("orders", body(sku, "none", 2), key)).status,
    409,
  );
  const stock = (
    await inventoryDb.query(
      "SELECT available,reserved FROM inventory WHERE sku=$1",
      [sku],
    )
  ).rows[0];
  assert.deepEqual(stock, { available: 9, reserved: 0 });
  // Refund requests are idempotent too; a shipped item is not automatically restocked.
  assert.equal((await request(`orders/${id}/refund`, {})).status, 202);
  await waitOrder(id, ["REFUNDED"]);
  assert.equal((await request(`orders/${id}/refund`, {})).status, 202);
  assert.equal(
    (
      await paymentDb.query(
        "SELECT count(*)::int AS n FROM payment_ledger WHERE order_id=$1 AND kind='REFUNDED'",
        [id],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    paymentDb.query("UPDATE payment_ledger SET amount=1 WHERE order_id=$1", [
      id,
    ]),
    /append only/,
  );
});
test("payment failure releases all reserved inventory", async () => {
  const sku = await product(4);
  const result = await request("orders", body(sku, "payment", 3), randomUUID());
  assert.equal(result.status, 202);
  const order = await waitOrder(result.data.id, ["CANCELLED"]);
  assert.ok(order.events.some((e: any) => e.name === "InventoryReleased"));
  assert.deepEqual(
    (
      await inventoryDb.query(
        "SELECT available,reserved FROM inventory WHERE sku=$1",
        [sku],
      )
    ).rows[0],
    { available: 4, reserved: 0 },
  );
});
test("three failed fulfillment attempts reach DLQ; retry does not recharge or double-reserve", async () => {
  const sku = await product(3);
  const result = await request(
    "orders",
    body(sku, "fulfillment"),
    randomUUID(),
  );
  assert.equal(result.status, 202);
  const order = await waitOrder(result.data.id, ["DEAD_LETTER"]);
  assert.equal(order.failure.service, "fulfillment");
  const job = (
    await fulfillmentDb.query("SELECT status,attempts FROM inbox WHERE id=$1", [
      order.failure.jobId,
    ])
  ).rows[0];
  assert.deepEqual(job, { status: "DEAD", attempts: 3 });
  assert.equal((await request(`orders/${order.id}/retry`, {})).status, 202);
  await waitOrder(order.id, ["FULFILLED"]);
  assert.equal(
    (
      await paymentDb.query(
        "SELECT count(*)::int AS n FROM payment_ledger WHERE order_id=$1 AND kind='CAPTURED'",
        [order.id],
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(
    (
      await inventoryDb.query(
        "SELECT available,reserved FROM inventory WHERE sku=$1",
        [sku],
      )
    ).rows[0],
    { available: 2, reserved: 0 },
  );
});
test("30 concurrent orders competing for ten units never oversell", async () => {
  const sku = await product(10);
  const results = await Promise.all(
    Array.from({ length: 30 }, () =>
      request("orders", body(sku), randomUUID()),
    ),
  );
  assert.ok(results.every((r) => r.status === 202));
  const orders = await Promise.all(
    results.map((r) => waitOrder(r.data.id, ["FULFILLED", "CANCELLED"])),
  );
  assert.equal(orders.filter((o) => o.status === "FULFILLED").length, 10);
  assert.equal(orders.filter((o) => o.status === "CANCELLED").length, 20);
  assert.deepEqual(
    (
      await inventoryDb.query(
        "SELECT available,reserved FROM inventory WHERE sku=$1",
        [sku],
      )
    ).rows[0],
    { available: 0, reserved: 0 },
  );
});
test("multi-item rejection leaves the other SKU untouched", async () => {
  const good = await product(8),
    soldOut = await product(0);
  const result = await request(
    "orders",
    {
      ...body(good),
      items: [
        { sku: good, quantity: 3 },
        { sku: soldOut, quantity: 1 },
      ],
    },
    randomUUID(),
  );
  await waitOrder(result.data.id, ["CANCELLED"]);
  assert.deepEqual(
    (
      await inventoryDb.query(
        "SELECT available,reserved FROM inventory WHERE sku=$1",
        [good],
      )
    ).rows[0],
    { available: 8, reserved: 0 },
  );
});
test("outbox rollback replays acknowledgements and durable inbox deduplicates them", async () => {
  const original = process.env.DATABASE_URL!;
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const pool = database(original);
  await pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(original);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  try {
    await migrate("order", url.toString());
    const a = event("OrderCreated", randomUUID(), "order"),
      b = event("OrderCreated", randomUUID(), "order");
    await transaction(async (db) => {
      await enqueue(db, a);
      await enqueue(db, b);
    });
    const delivered: string[] = [];
    let calls = 0;
    await assert.rejects(
      publishOutbox({
        send: async (record: any) => {
          delivered.push(record.messages[0].value);
          if (++calls === 2) throw new Error("Broker response lost");
          return [];
        },
      }),
    );
    assert.equal(
      (
        await database().query(
          "SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL",
        )
      ).rows[0].n,
      2,
    );
    await publishOutbox({
      send: async (record: any) => {
        delivered.push(record.messages[0].value);
        return [];
      },
    });
    for (const raw of delivered) {
      const e = JSON.parse(raw);
      await database().query(
        "INSERT INTO inbox(id,aggregate_id,event) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [e.id, e.orderId, raw],
      );
    }
    let applied = 0;
    while (
      await processOne(async () => {
        applied++;
      })
    ) {}
    assert.equal(delivered.length, 4);
    assert.equal(applied, 2);
  } finally {
    process.env.DATABASE_URL = original;
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});
after(closeDatabases);

test("Stripe settlement and webhook signatures are idempotent against a real database", async () => {
  const { settleIntent, webhook, stripe } =
    await import("../../src/backend/payments");
  const original = process.env.DATABASE_URL!;
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const pool = database(original);
  await pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(original);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture_not_a_real_key";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fixture_secret";
  try {
    await migrate("payment", url.toString());
    const id = randomUUID();
    await database().query(
      "INSERT INTO payments(order_id,amount,currency,provider,status,provider_id) VALUES($1,1500,'usd','stripe','ACTION_REQUIRED','pi_fixture')",
      [id],
    );
    const intent = {
      id: "pi_fixture",
      amount: 1500,
      currency: "usd",
      metadata: { order_id: id },
      status: "succeeded",
    };
    await assert.rejects(
      transaction((db) => settleIntent(db, { ...intent, amount: 1 } as any)),
      /identity mismatch/,
    );
    await transaction((db) => settleIntent(db, intent as any));
    await transaction((db) => settleIntent(db, intent as any));
    await transaction((db) =>
      settleIntent(db, { ...intent, status: "canceled" } as any),
    );
    assert.equal(
      (
        await database().query(
          "SELECT status FROM payments WHERE order_id=$1",
          [id],
        )
      ).rows[0].status,
      "CAPTURED",
    );
    assert.equal(
      (await database().query("SELECT count(*)::int AS n FROM payment_ledger"))
        .rows[0].n,
      1,
    );
    assert.equal(
      (await database().query("SELECT count(*)::int AS n FROM outbox")).rows[0]
        .n,
      1,
    );
    const raw = JSON.stringify({
      id: "evt_fixture",
      object: "event",
      type: "customer.created",
      data: { object: { id: "cus_fixture" } },
    });
    const signature = stripe().webhooks.generateTestHeaderString({
      payload: raw,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });
    await webhook(Buffer.from(raw), signature);
    await webhook(Buffer.from(raw), signature);
    assert.equal(
      (await database().query("SELECT count(*)::int AS n FROM stripe_webhooks"))
        .rows[0].n,
      1,
    );
    await assert.rejects(
      webhook(Buffer.from(raw + " "), signature),
      /signature/i,
    );
  } finally {
    process.env.DATABASE_URL = original;
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});
