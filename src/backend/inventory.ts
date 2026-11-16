import type { DB } from "./db";
import { emit, workflowData, type Event } from "./events";
export async function inventory(db: DB, e: Event) {
  if (e.type === "ReserveInventory") {
    const data = workflowData.parse(e.data);
    if (
      (
        await db.query("SELECT 1 FROM reservations WHERE order_id=$1", [
          e.orderId,
        ])
      ).rowCount
    )
      return;
    // Sorted row locks prevent deadlocks for multi-SKU baskets. OCC is the final write guard.
    const rows = (
      await db.query(
        "SELECT * FROM inventory WHERE sku=ANY($1) ORDER BY sku FOR UPDATE",
        [data.items.map((i) => i.sku)],
      )
    ).rows;
    const enough = data.items.every((item) =>
      rows.some((s) => s.sku === item.sku && s.available >= item.quantity),
    );
    await db.query(
      "INSERT INTO reservations(order_id,items,status) VALUES($1,$2,$3)",
      [e.orderId, JSON.stringify(data.items), enough ? "RESERVED" : "REJECTED"],
    );
    if (!enough) {
      await emit(db, e, "InventoryRejected", "inventory", {
        reason: "INSUFFICIENT_STOCK",
      });
      return;
    }
    for (const item of data.items) {
      const stock = rows.find((s) => s.sku === item.sku)!;
      const result = await db.query(
        "UPDATE inventory SET available=available-$2,reserved=reserved+$2,version=version+1,updated_at=now() WHERE sku=$1 AND available>=$2 AND version=$3",
        [item.sku, item.quantity, stock.version],
      );
      if (result.rowCount !== 1) throw new Error("Inventory version conflict");
    }
    await emit(db, e, "InventoryReserved", "inventory", { items: data.items });
  } else {
    const reservation = (
      await db.query(
        "SELECT * FROM reservations WHERE order_id=$1 FOR UPDATE",
        [e.orderId],
      )
    ).rows[0];
    if (!reservation) throw new Error("Missing reservation");
    if (reservation.status !== "RESERVED") return;
    const items = workflowData.shape.items
      .parse(reservation.items)
      .sort((a, b) => a.sku.localeCompare(b.sku));
    for (const item of items) {
      const result = await db.query(
        "UPDATE inventory SET reserved=reserved-$2,available=available+$3,version=version+1,updated_at=now() WHERE sku=$1 AND reserved>=$2",
        [
          item.sku,
          item.quantity,
          e.type === "ReleaseInventory" ? item.quantity : 0,
        ],
      );
      if (result.rowCount !== 1)
        throw new Error("Reservation invariant violated");
    }
    const release = e.type === "ReleaseInventory";
    await db.query("UPDATE reservations SET status=$2 WHERE order_id=$1", [
      e.orderId,
      release ? "RELEASED" : "CONSUMED",
    ]);
    await emit(
      db,
      e,
      release ? "InventoryReleased" : "InventoryCommitted",
      "inventory",
    );
  }
}
