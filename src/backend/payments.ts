import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { paymentProvider, required } from "./config";
import { database, transaction, type DB } from "./db";
import { emit, event, enqueue, workflowData, type Event } from "./events";
import { deadLetter } from "./messaging";
let stripeClient: Stripe | undefined;
export function stripe() {
  return (stripeClient ??= new Stripe(required("STRIPE_SECRET_KEY"), {
    timeout: 15000,
    maxNetworkRetries: 1,
  }));
}
export class ReconciliationRequired extends Error {
  name = "ReconciliationRequired";
}
export function checkIdempotencyWindow(time: string) {
  if (Date.now() - new Date(time).getTime() > 23 * 3600000)
    throw new ReconciliationRequired(
      "Provider operation requires reconciliation before retry",
    );
}
async function ledger(
  db: DB,
  orderId: string,
  kind: string,
  amount: number,
  currency: string,
  reference: string | null,
) {
  await db.query(
    "INSERT INTO payment_ledger(id,order_id,kind,amount,currency,provider_reference) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(order_id,kind) DO NOTHING",
    [randomUUID(), orderId, kind, amount, currency, reference],
  );
}
export async function settleIntent(
  db: DB,
  intent: Stripe.PaymentIntent,
  parent?: Event,
) {
  const p = (
    await db.query("SELECT * FROM payments WHERE provider_id=$1 FOR UPDATE", [
      intent.id,
    ])
  ).rows[0];
  if (!p) throw new Error("Payment not yet persisted"); // Stripe retries a webhook racing the create transaction.
  if (
    intent.amount !== p.amount ||
    intent.currency !== p.currency ||
    intent.metadata.order_id !== p.order_id
  )
    throw new Error("Payment identity mismatch");
  if (!["CREATING", "ACTION_REQUIRED"].includes(p.status)) return;
  const captured = intent.status === "succeeded";
  if (!captured && intent.status !== "canceled") return;
  const status = captured ? "CAPTURED" : "FAILED";
  await db.query(
    "UPDATE payments SET status=$2,client_secret=NULL,updated_at=now() WHERE order_id=$1",
    [p.order_id, status],
  );
  await ledger(db, p.order_id, status, p.amount, p.currency, p.provider_id);
  const e = parent || event("CreatePayment", p.order_id, "payment");
  await emit(db, e, captured ? "PaymentCaptured" : "PaymentFailed", "payment", {
    provider: "stripe",
    reference: intent.id,
  });
}
async function settleRefund(db: DB, refund: Stripe.Refund, parent?: Event) {
  const match = (
    await db.query("SELECT order_id FROM refunds WHERE provider_id=$1", [
      refund.id,
    ])
  ).rows[0];
  if (!match) throw new Error("Refund not yet persisted");
  const p = (
    await db.query("SELECT * FROM payments WHERE order_id=$1 FOR UPDATE", [
      match.order_id,
    ])
  ).rows[0];
  const row = (
    await db.query("SELECT * FROM refunds WHERE order_id=$1 FOR UPDATE", [
      match.order_id,
    ])
  ).rows[0];
  if (p.status === "REFUNDED") return;
  if (
    refund.amount !== p.amount ||
    refund.currency !== p.currency ||
    refund.payment_intent !== p.provider_id
  )
    throw new Error("Refund identity mismatch");
  if (refund.status === "succeeded") {
    await db.query("UPDATE refunds SET status='SUCCEEDED' WHERE order_id=$1", [
      p.order_id,
    ]);
    await db.query(
      "UPDATE payments SET status='REFUNDED',updated_at=now() WHERE order_id=$1",
      [p.order_id],
    );
    await ledger(db, p.order_id, "REFUNDED", p.amount, p.currency, refund.id);
    await emit(
      db,
      parent || event("RefundPayment", p.order_id, "payment"),
      "PaymentRefunded",
      "payment",
      { reference: refund.id },
    );
  } else if (refund.status === "failed" || refund.status === "canceled") {
    if (row.status === "FAILED") return;
    if (parent) throw new ReconciliationRequired();
    await db.query("UPDATE refunds SET status='FAILED' WHERE order_id=$1", [
      p.order_id,
    ]);
    const original = (
      await db.query("SELECT event FROM inbox WHERE id=$1", [row.job_id])
    ).rows[0];
    if (original)
      await deadLetter(db, original.event, "RefundReconciliationRequired");
  }
}
export async function payment(db: DB, e: Event) {
  if (e.type === "RefundPayment") {
    const p = (
      await db.query("SELECT * FROM payments WHERE order_id=$1 FOR UPDATE", [
        e.orderId,
      ])
    ).rows[0];
    if (!p) throw new Error("Missing payment");
    if (p.status === "REFUNDED") return;
    if (!["CAPTURED", "REFUND_PENDING"].includes(p.status))
      throw new Error("Payment is not refundable");
    if (p.provider === "mock") {
      await db.query(
        "UPDATE payments SET status='REFUNDED',updated_at=now() WHERE order_id=$1",
        [p.order_id],
      );
      await ledger(
        db,
        p.order_id,
        "REFUNDED",
        p.amount,
        p.currency,
        `mock-refund-${p.order_id}`,
      );
      await emit(db, e, "PaymentRefunded", "payment", { provider: "mock" });
      return;
    }
    await db.query(
      "INSERT INTO refunds(order_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [p.order_id, e.id],
    );
    const row = (
      await db.query("SELECT * FROM refunds WHERE order_id=$1", [p.order_id])
    ).rows[0];
    if (row.status === "FAILED") throw new ReconciliationRequired();
    let refund: Stripe.Refund;
    if (row.provider_id)
      refund = await stripe().refunds.retrieve(row.provider_id);
    else {
      checkIdempotencyWindow(e.time);
      refund = await stripe().refunds.create(
        {
          payment_intent: p.provider_id,
          amount: p.amount,
          metadata: { order_id: p.order_id },
        },
        { idempotencyKey: `nexusflow:refund:${p.order_id}` },
      );
    }
    await db.query("UPDATE refunds SET provider_id=$2 WHERE order_id=$1", [
      p.order_id,
      refund.id,
    ]);
    await db.query(
      "UPDATE payments SET status='REFUND_PENDING',updated_at=now() WHERE order_id=$1",
      [p.order_id],
    );
    await settleRefund(db, refund, e);
    return;
  }
  const data = workflowData.parse(e.data),
    provider = paymentProvider();
  await db.query(
    "INSERT INTO payments(order_id,amount,currency,provider,status) VALUES($1,$2,$3,$4,'CREATING') ON CONFLICT DO NOTHING",
    [e.orderId, data.amount, data.currency, provider],
  );
  const p = (
    await db.query("SELECT * FROM payments WHERE order_id=$1 FOR UPDATE", [
      e.orderId,
    ])
  ).rows[0];
  if (p.status !== "CREATING") return;
  if (provider === "mock") {
    const failed =
      data.fault === "payment" && process.env.ALLOW_FAULT_INJECTION === "true";
    await db.query(
      "UPDATE payments SET status=$2,provider_id=$3,updated_at=now() WHERE order_id=$1",
      [e.orderId, failed ? "FAILED" : "CAPTURED", `mock-${e.orderId}`],
    );
    await ledger(
      db,
      e.orderId,
      failed ? "FAILED" : "CAPTURED",
      data.amount,
      data.currency,
      `mock-${e.orderId}`,
    );
    await emit(db, e, failed ? "PaymentFailed" : "PaymentCaptured", "payment", {
      provider: "mock",
    });
    return;
  }
  // Persisting the result and its outbox event is one transaction. A lost response retries the same Stripe key.
  checkIdempotencyWindow(e.time);
  const intent = await stripe().paymentIntents.create(
    {
      amount: data.amount,
      currency: data.currency,
      allowed_payment_method_types: ["card"],
      metadata: { order_id: e.orderId },
    },
    { idempotencyKey: `nexusflow:payment:${e.orderId}` },
  );
  await db.query(
    "UPDATE payments SET provider_id=$2,client_secret=$3,status='ACTION_REQUIRED',updated_at=now() WHERE order_id=$1",
    [e.orderId, intent.id, intent.client_secret],
  );
  await emit(db, e, "PaymentActionRequired", "payment", { provider: "stripe" });
  await settleIntent(db, intent, e);
}
export async function webhook(raw: Buffer, signature: string) {
  const incoming = stripe().webhooks.constructEvent(
    raw,
    signature,
    required("STRIPE_WEBHOOK_SECRET"),
  );
  await transaction(async (db) => {
    const inserted = await db.query(
      "INSERT INTO stripe_webhooks(id,type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id",
      [incoming.id, incoming.type],
    );
    if (!inserted.rowCount) return;
    if (
      ["payment_intent.succeeded", "payment_intent.canceled"].includes(
        incoming.type,
      )
    ) {
      const intent = incoming.data.object as Stripe.PaymentIntent;
      // Ignore other applications' objects on a shared Stripe account. A matching
      // inbox entry still makes a webhook racing our create transaction retryable.
      const orderId = intent.metadata?.order_id;
      if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return;
      const tracked = await db.query(
        "SELECT 1 FROM inbox WHERE aggregate_id=$1 UNION ALL SELECT 1 FROM payments WHERE order_id=$1 LIMIT 1",
        [orderId],
      );
      if (!tracked.rowCount) return;
      // Retrieve current state so delayed webhooks cannot regress a payment.
      await settleIntent(db, await stripe().paymentIntents.retrieve(intent.id));
    }
    if (
      ["refund.created", "refund.updated", "refund.failed"].includes(
        incoming.type,
      )
    ) {
      const refund = incoming.data.object as Stripe.Refund;
      const orderId = refund.metadata?.order_id;
      if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return;
      const tracked = await db.query(
        "SELECT 1 FROM inbox WHERE aggregate_id=$1 UNION ALL SELECT 1 FROM payments WHERE order_id=$1 LIMIT 1",
        [orderId],
      );
      if (!tracked.rowCount) return;
      await settleRefund(db, await stripe().refunds.retrieve(refund.id));
    }
  });
}
export async function reconcilePayments() {
  if (paymentProvider() !== "stripe") return;
  // One reconciler per DB; network calls are bounded and failures are retried next cycle.
  await transaction(async (db) => {
    if (
      !(await db.query("SELECT pg_try_advisory_xact_lock(7913003) AS acquired"))
        .rows[0].acquired
    )
      return;
    const pending = (
      await db.query(
        "SELECT * FROM payments WHERE status IN ('ACTION_REQUIRED','REFUND_PENDING') ORDER BY updated_at LIMIT 20 FOR UPDATE SKIP LOCKED",
      )
    ).rows;
    for (const p of pending) {
      if (p.status === "REFUND_PENDING") {
        const refund = (
          await db.query("SELECT * FROM refunds WHERE order_id=$1", [
            p.order_id,
          ])
        ).rows[0];
        if (refund?.provider_id)
          await settleRefund(
            db,
            await stripe().refunds.retrieve(refund.provider_id),
          );
      } else {
        let intent = await stripe().paymentIntents.retrieve(p.provider_id);
        if (
          new Date(p.expires_at).getTime() < Date.now() &&
          !["succeeded", "canceled", "processing"].includes(intent.status)
        ) {
          try {
            intent = await stripe().paymentIntents.cancel(
              intent.id,
              {},
              { idempotencyKey: `nexusflow:expire:${p.order_id}` },
            );
          } catch {
            intent = await stripe().paymentIntents.retrieve(intent.id);
          }
        }
        await settleIntent(db, intent);
      }
      await db.query("UPDATE payments SET updated_at=now() WHERE order_id=$1", [
        p.order_id,
      ]);
    }
  });
}
