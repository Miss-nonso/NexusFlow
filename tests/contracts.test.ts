import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { orderInput, fingerprint } from "../src/backend/orders";
import { event, envelopeSchema } from "../src/backend/events";
import {
  checkIdempotencyWindow,
  ReconciliationRequired,
} from "../src/backend/payments";
const body = {
  customer: "Customer",
  email: "customer@example.com",
  items: [
    { sku: "SKU-A", quantity: 1 },
    { sku: "SKU-B", quantity: 2 },
  ],
  fault: "none" as const,
};
test("prices and duplicate SKU lines cannot be supplied by clients", () => {
  assert.equal(
    orderInput.safeParse({
      ...body,
      items: [{ sku: "SKU-A", quantity: 1, unitPrice: 1 }],
    }).success,
    false,
  );
  assert.equal(
    orderInput.safeParse({ ...body, items: [body.items[0], body.items[0]] })
      .success,
    false,
  );
  for (const quantity of [-1, 0, 1.2, 101])
    assert.equal(
      orderInput.safeParse({ ...body, items: [{ sku: "SKU-A", quantity }] })
        .success,
      false,
    );
});
test("idempotency fingerprint ignores line ordering but binds quantity", () => {
  assert.equal(
    fingerprint(body),
    fingerprint({ ...body, items: [...body.items].reverse() }),
  );
  assert.notEqual(
    fingerprint(body),
    fingerprint({ ...body, items: [{ sku: "SKU-A", quantity: 2 }] }),
  );
});
test("event envelopes require supported version and UUID partition identity", () => {
  const e = event("OrderCreated", randomUUID(), "order");
  assert.equal(envelopeSchema.safeParse(e).success, true);
  assert.equal(envelopeSchema.safeParse({ ...e, version: 2 }).success, false);
  assert.equal(
    envelopeSchema.safeParse({ ...e, orderId: "not-an-order" }).success,
    false,
  );
});
test("ambiguous Stripe operations cannot be recreated after its idempotency window", () => {
  assert.doesNotThrow(() => checkIdempotencyWindow(new Date().toISOString()));
  assert.throws(
    () =>
      checkIdempotencyWindow(new Date(Date.now() - 24 * 3600000).toISOString()),
    ReconciliationRequired,
  );
});
