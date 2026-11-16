import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
const cwd = fileURLToPath(new URL("..", import.meta.url));
process.loadEnvFile(`${cwd}/.env`);
if (process.env.PAYMENT_PROVIDER !== "mock")
  throw new Error("This check is limited to the local payment provider");
const context =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0
    ? []
    : ["--context", "default"];
function compose(...args) {
  const p = spawnSync("docker", [...context, "compose", ...args], {
    cwd,
    stdio: "inherit",
  });
  if (p.status !== 0) throw new Error("Docker operation failed");
}
async function api(path, body, key) {
  const r = await fetch(`${process.env.APP_ORIGIN}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${process.env.ADMIN_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
async function fulfilled(id) {
  for (let i = 0; i < 120; i++) {
    try {
      const o = await api(`orders/${id}`);
      if (o.status === "FULFILLED") return o;
      if (o.status === "CANCELLED")
        throw new Error("Fixture had insufficient stock");
    } catch (e) {
      if (i === 119) throw e;
    }
    await sleep(1000);
  }
  throw new Error("Order did not recover within two minutes");
}
const stock = (await api("state")).stock.find((s) => s.available >= 2);
if (!stock)
  throw new Error(
    "Need at least two units of inventory for this non-destructive check",
  );
const input = {
  customer: "Resilience check",
  email: "resilience@example.test",
  items: [{ sku: stock.sku, quantity: 1 }],
  fault: "none",
};
const key = randomUUID(),
  first = await api("orders", input, key);
await fulfilled(first.id);
compose(
  "restart",
  "order-worker",
  "inventory-worker",
  "payment-worker",
  "fulfillment-worker",
  "web",
);
await fulfilled(first.id);
assert.equal((await api("orders", input, key)).id, first.id);
console.log("PASS: order and idempotency key survive service restarts");
let queued;
try {
  compose("stop", "kafka");
  queued = await api("orders", input, randomUUID());
  await sleep(1500);
  assert.equal((await api(`orders/${queued.id}`)).status, "PROCESSING");
  console.log("PASS: order accepted durably while Kafka is unavailable");
} finally {
  compose("start", "kafka");
}
const recovered = await fulfilled(queued.id);
assert.equal(
  recovered.events.filter((e) => e.name === "PaymentCaptured").length,
  1,
);
console.log("PASS: Kafka recovery drains the outbox and captures payment once");
