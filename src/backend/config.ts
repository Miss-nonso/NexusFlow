export const roles = ["order", "inventory", "payment", "fulfillment"] as const;
export type Role = (typeof roles)[number];
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}
export function role(): Role {
  const value = process.env.SERVICE_ROLE || "order";
  if (!roles.includes(value as Role)) throw new Error("Invalid SERVICE_ROLE");
  return value as Role;
}
export const topic = process.env.KAFKA_TOPIC || "nexusflow.events.v1";
export const dlqTopic = process.env.KAFKA_DLQ_TOPIC || "nexusflow.dlq.v1";
export function paymentProvider() {
  const value = process.env.PAYMENT_PROVIDER || "mock";
  if (value !== "mock" && value !== "stripe")
    throw new Error("Invalid PAYMENT_PROVIDER");
  return value;
}
export function validateSecrets(worker = false) {
  for (const key of worker
    ? ["INTERNAL_TOKEN"]
    : ["INTERNAL_TOKEN", "SESSION_SECRET", "ADMIN_API_TOKEN"]) {
    if (required(key).length < 32)
      throw new Error(`${key} must have at least 32 characters`);
  }
  if (!worker && required("ADMIN_PASSWORD").length < 12)
    throw new Error("ADMIN_PASSWORD must have at least 12 characters");
  const origin = new URL(required("APP_ORIGIN"));
  if (process.env.SECURE_COOKIES === "true" && origin.protocol !== "https:")
    throw new Error("Secure cookies require HTTPS APP_ORIGIN");
  if (paymentProvider() === "stripe" && role() === "payment") {
    const key = required("STRIPE_SECRET_KEY");
    required("STRIPE_WEBHOOK_SECRET");
    if (
      key.startsWith("sk_live_") &&
      process.env.ALLOW_LIVE_PAYMENTS !== "true"
    )
      throw new Error("Live Stripe payments require ALLOW_LIVE_PAYMENTS=true");
  }
}
