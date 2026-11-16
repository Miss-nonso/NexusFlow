import type { DB } from "./db";
import { emit, type Event, type EventType } from "./events";
export async function orchestrate(db: DB, e: Event) {
  const order = (
    await db.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [e.orderId])
  ).rows[0];
  if (!order) throw new Error("Unknown order");
  await db.query(
    "INSERT INTO order_events(event_id,order_id,name,service,occurred_at,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    [e.id, e.orderId, e.type, e.source, e.time, JSON.stringify(e.data)],
  );
  const command = async (type: EventType) =>
    emit(db, e, type, "order", {
      items: order.items,
      amount: order.amount,
      currency: order.currency,
      fault: order.fault,
    });
  const update = async (status: string, stage: string, terminal = false) =>
    db.query(
      "UPDATE orders SET status=$2,stage=$3,version=version+1,updated_at=now(),completed_at=CASE WHEN $4 THEN now() ELSE NULL END, fulfilled_at=CASE WHEN $3='FULFILLED' THEN now() ELSE fulfilled_at END WHERE id=$1",
      [order.id, status, stage, terminal],
    );
  switch (e.type) {
    case "OrderCreated":
      if (order.stage === "CREATED") {
        await command("ReserveInventory");
        await update("PROCESSING", "RESERVING");
      }
      break;
    case "InventoryReserved":
      if (order.stage === "RESERVING") {
        await command("CreatePayment");
        await update("PROCESSING", "PAYING");
      }
      break;
    case "InventoryRejected":
      if (order.stage === "RESERVING")
        await update("CANCELLED", "REJECTED", true);
      break;
    case "PaymentActionRequired":
      if (order.stage === "PAYING") await update("PAYMENT_PENDING", "PAYING");
      break;
    case "PaymentCaptured":
      if (order.stage === "PAYING") {
        await command("FulfillOrder");
        await update("PROCESSING", "FULFILLING");
      }
      break;
    case "PaymentFailed":
      if (order.stage === "PAYING") {
        await command("ReleaseInventory");
        await update("CANCELLING", "RELEASING");
      }
      break;
    case "InventoryReleased":
      if (order.stage === "RELEASING")
        await update("CANCELLED", "COMPENSATED", true);
      break;
    case "ShipmentDispatched":
      if (order.stage === "FULFILLING") {
        await command("CommitInventory");
        await update("PROCESSING", "COMMITTING");
      }
      break;
    case "InventoryCommitted":
      if (order.stage === "COMMITTING")
        await update("FULFILLED", "FULFILLED", true);
      break;
    case "PaymentRefunded":
      if (order.stage === "REFUNDING")
        await update("REFUNDED", "REFUNDED", true);
      break;
    case "WorkflowFailed":
      if (!["FULFILLED", "CANCELLED", "REFUNDED"].includes(order.status)) {
        await db.query(
          "UPDATE orders SET status='DEAD_LETTER',failure=$2,updated_at=now(),version=version+1 WHERE id=$1",
          [order.id, JSON.stringify({ ...e.data, resumeStatus: order.status })],
        );
      }
      break;
  }
}
