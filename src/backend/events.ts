import { randomUUID } from "node:crypto";
import { z } from "zod";
import { topic, type Role } from "./config";
import type { DB } from "./db";
import { currentTrace } from "./telemetry";
export const itemSchema = z.object({
  sku: z.string().regex(/^[A-Z0-9-]{1,64}$/),
  quantity: z.number().int().min(1).max(100),
  unitPrice: z.number().int().positive().optional(),
});
export const eventTypes = [
  "OrderCreated",
  "ReserveInventory",
  "InventoryReserved",
  "InventoryRejected",
  "CreatePayment",
  "PaymentActionRequired",
  "PaymentCaptured",
  "PaymentFailed",
  "ReleaseInventory",
  "InventoryReleased",
  "FulfillOrder",
  "ShipmentDispatched",
  "CommitInventory",
  "InventoryCommitted",
  "WorkflowFailed",
  "RetryDelivery",
  "RefundPayment",
  "PaymentRefunded",
] as const;
export type EventType = (typeof eventTypes)[number];
export const envelopeSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  orderId: z.uuid(),
  type: z.enum(eventTypes),
  source: z.enum(["order", "inventory", "payment", "fulfillment"]),
  time: z.iso.datetime(),
  traceparent: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});
export type Event = z.infer<typeof envelopeSchema>;
export const workflowData = z.object({
  items: z.array(itemSchema).min(1).max(20),
  amount: z.number().int().positive().max(100_000_000),
  currency: z.literal("usd"),
  fault: z.enum(["none", "payment", "fulfillment"]).default("none"),
});
export function event(
  type: EventType,
  orderId: string,
  source: Role,
  data: Event["data"] = {},
  traceparent?: string,
): Event {
  return {
    version: 1,
    id: randomUUID(),
    orderId,
    type,
    source,
    time: new Date().toISOString(),
    data,
    ...(traceparent ? { traceparent } : {}),
  };
}
export async function enqueue(db: DB, e: Event, targetTopic = topic) {
  await db.query(
    "INSERT INTO outbox(id,aggregate_id,topic,event) VALUES($1,$2,$3,$4)",
    [e.id, e.orderId, targetTopic, JSON.stringify(e)],
  );
}
export async function emit(
  db: DB,
  parent: Event,
  type: EventType,
  source: Role,
  data: Event["data"] = {},
) {
  const e = event(type, parent.orderId, source, data, parent.traceparent);
  await enqueue(db, e);
  return e;
}
export const subscriptions: Record<Role, EventType[]> = {
  order: [
    "RetryDelivery",
    "OrderCreated",
    "InventoryReserved",
    "InventoryRejected",
    "PaymentActionRequired",
    "PaymentCaptured",
    "PaymentFailed",
    "InventoryReleased",
    "ShipmentDispatched",
    "InventoryCommitted",
    "WorkflowFailed",
    "PaymentRefunded",
  ],
  inventory: [
    "ReserveInventory",
    "ReleaseInventory",
    "CommitInventory",
    "RetryDelivery",
  ],
  payment: ["CreatePayment", "RefundPayment", "RetryDelivery"],
  fulfillment: ["FulfillOrder", "RetryDelivery"],
};
