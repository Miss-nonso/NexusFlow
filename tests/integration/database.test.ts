import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database, transaction, closeDatabases } from "../../src/backend/db";
import { migrate } from "../../src/backend/migrate";
import { inventory } from "../../src/backend/inventory";
import { orchestrate } from "../../src/backend/orchestrator";
import { payment } from "../../src/backend/payments";
import { fulfill } from "../../src/backend/fulfillment";
import {
  event,
  enqueue,
  subscriptions,
  type Event,
} from "../../src/backend/events";
import { publishOutbox, processOne } from "../../src/backend/messaging";
import { roles, type Role } from "../../src/backend/config";
if (process.env.TEST_TARGET_APPROVED !== "true")
  throw new Error("Use an explicitly approved test database");
const originalUrl = process.env.DATABASE_URL!,
  originalRole = process.env.SERVICE_ROLE;
const pools = database(originalUrl);
async function fixture(role: Role) {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await pools.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(originalUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  await migrate(role, url.toString());
  return {
    schema,
    url: url.toString(),
    pool: database(url.toString()),
    cleanup: () => pools.query(`DROP SCHEMA ${schema} CASCADE`),
  };
}
test("real concurrent SQL reservations cannot oversell; duplicate reserve/release are harmless", async () => {
  const f = await fixture("inventory");
  try {
    await f.pool.query(
      "UPDATE inventory SET available=10 WHERE sku='NF-KB-001'",
    );
    const commands = Array.from({ length: 40 }, () =>
      event("ReserveInventory", randomUUID(), "order", {
        items: [{ sku: "NF-KB-001", quantity: 1, unitPrice: 14900 }],
        amount: 14900,
        currency: "usd",
        fault: "none",
      }),
    );
    await Promise.all(
      commands.map((e) => transaction((db) => inventory(db, e), f.pool)),
    );
    const held = (
      await f.pool.query(
        "SELECT order_id FROM reservations WHERE status='RESERVED'",
      )
    ).rows;
    assert.equal(held.length, 10);
    for (const e of commands)
      await transaction((db) => inventory(db, e), f.pool);
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT available,reserved FROM inventory WHERE sku='NF-KB-001'",
        )
      ).rows[0],
      { available: 0, reserved: 10 },
    );
    for (const row of held) {
      const release = event("ReleaseInventory", row.order_id, "order");
      await transaction((db) => inventory(db, release), f.pool);
      await transaction((db) => inventory(db, release), f.pool);
    }
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT available,reserved FROM inventory WHERE sku='NF-KB-001'",
        )
      ).rows[0],
      { available: 10, reserved: 0 },
    );
  } finally {
    await f.cleanup();
  }
});
test("full durable saga compensates, retries and refunds across isolated service schemas", async () => {
  const fixtures = Object.fromEntries(
    await Promise.all(roles.map(async (r) => [r, await fixture(r)])),
  ) as Record<Role, Awaited<ReturnType<typeof fixture>>>;
  const handlers = {
    order: orchestrate,
    inventory,
    payment,
    fulfillment: fulfill,
  };
  const oldProvider = process.env.PAYMENT_PROVIDER,
    oldFault = process.env.ALLOW_FAULT_INJECTION;
  process.env.PAYMENT_PROVIDER = "mock";
  process.env.ALLOW_FAULT_INJECTION = "true";
  async function insertOrder(fault: string) {
    const id = randomUUID();
    await transaction(async (db) => {
      await db.query(
        "INSERT INTO orders(id,idempotency_key,request_hash,customer,email,items,amount,currency,status,stage,fault) VALUES($1,$2,'fixture','Test','test@example.test',$3,14900,'usd','PROCESSING','CREATED',$4)",
        [
          id,
          randomUUID(),
          JSON.stringify([{ sku: "NF-KB-001", quantity: 1, unitPrice: 14900 }]),
          fault,
        ],
      );
      await enqueue(db, event("OrderCreated", id, "order"));
    }, fixtures.order.pool);
    return id;
  }
  async function pump() {
    for (let cycle = 0; cycle < 30; cycle++) {
      let work = 0;
      for (const r of roles) {
        process.env.SERVICE_ROLE = r;
        process.env.DATABASE_URL = fixtures[r].url;
        await fixtures[r].pool.query(
          "UPDATE inbox SET available_at=now() WHERE status='PENDING'",
        );
        while (await processOne(handlers[r])) work++;
        work += await publishOutbox({
          send: async (record: any) => {
            if (record.topic.endsWith(".dlq.v1")) return [];
            for (const message of record.messages) {
              const e = JSON.parse(message.value) as Event;
              for (const destination of roles) {
                if (!subscriptions[destination].includes(e.type)) continue;
                if (
                  e.type === "RetryDelivery" &&
                  e.data.service !== destination
                )
                  continue;
                await fixtures[destination].pool.query(
                  "INSERT INTO inbox(id,aggregate_id,event) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                  [e.id, e.orderId, message.value],
                );
              }
            }
            return [];
          },
        });
      }
      if (work === 0) return;
    }
    throw new Error("Saga did not quiesce");
  }
  try {
    const happy = await insertOrder("none"),
      declined = await insertOrder("payment"),
      failed = await insertOrder("fulfillment");
    await pump();
    const read = async (id: string) =>
      (
        await fixtures.order.pool.query("SELECT * FROM orders WHERE id=$1", [
          id,
        ])
      ).rows[0];
    assert.equal((await read(happy)).status, "FULFILLED");
    assert.equal((await read(declined)).status, "CANCELLED");
    const dead = await read(failed);
    assert.equal(dead.status, "DEAD_LETTER");
    assert.deepEqual(
      (
        await fixtures.inventory.pool.query(
          "SELECT available,reserved FROM inventory WHERE sku='NF-KB-001'",
        )
      ).rows[0],
      { available: 426, reserved: 1 },
    );
    await transaction(async (db) => {
      await enqueue(
        db,
        event("RetryDelivery", failed, "order", {
          service: "fulfillment",
          jobId: dead.failure.jobId,
        }),
      );
      await db.query(
        "UPDATE orders SET status='PROCESSING',failure=NULL WHERE id=$1",
        [failed],
      );
    }, fixtures.order.pool);
    await pump();
    assert.equal((await read(failed)).status, "FULFILLED");
    assert.equal(
      (
        await fixtures.payment.pool.query(
          "SELECT count(*)::int AS n FROM payment_ledger WHERE order_id=$1 AND kind='CAPTURED'",
          [failed],
        )
      ).rows[0].n,
      1,
    );
    await transaction(async (db) => {
      await db.query(
        "UPDATE orders SET status='REFUNDING',stage='REFUNDING' WHERE id=$1",
        [happy],
      );
      await enqueue(db, event("RefundPayment", happy, "order"));
    }, fixtures.order.pool);
    await pump();
    assert.equal((await read(happy)).status, "REFUNDED");
    assert.deepEqual(
      (
        await fixtures.inventory.pool.query(
          "SELECT available,reserved FROM inventory WHERE sku='NF-KB-001'",
        )
      ).rows[0],
      { available: 426, reserved: 0 },
    );
  } finally {
    process.env.DATABASE_URL = originalUrl;
    if (originalRole) process.env.SERVICE_ROLE = originalRole;
    else delete process.env.SERVICE_ROLE;
    if (oldProvider) process.env.PAYMENT_PROVIDER = oldProvider;
    else delete process.env.PAYMENT_PROVIDER;
    if (oldFault) process.env.ALLOW_FAULT_INJECTION = oldFault;
    else delete process.env.ALLOW_FAULT_INJECTION;
    for (const r of roles) await fixtures[r].cleanup();
  }
});
after(closeDatabases);
