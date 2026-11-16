import type { DB } from "./db";
import { emit, workflowData, type Event } from "./events";
export class InjectedFulfillmentFault extends Error {
  name = "InjectedFulfillmentFault";
}
export async function fulfill(db: DB, e: Event, replays: number) {
  const data = workflowData.parse(e.data);
  if (
    data.fault === "fulfillment" &&
    process.env.ALLOW_FAULT_INJECTION === "true" &&
    replays === 0
  )
    throw new InjectedFulfillmentFault();
  const shipment = await db.query(
    "INSERT INTO shipments(order_id,reference,items) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING reference",
    [e.orderId, `NF-${e.orderId}`, JSON.stringify(data.items)],
  );
  if (shipment.rowCount)
    await emit(db, e, "ShipmentDispatched", "fulfillment", {
      reference: shipment.rows[0].reference,
    });
}
