import { required } from "./config";
export async function internal(
  service: "inventory" | "payment" | "fulfillment" | "order",
  path: string,
  init: RequestInit = {},
) {
  const developmentPorts = {
    order: 4001,
    inventory: 4002,
    payment: 4003,
    fulfillment: 4004,
  } as const;
  const url =
    process.env[`${service.toUpperCase()}_SERVICE_URL`] ||
    (process.env.NODE_ENV === "production"
      ? required(`${service.toUpperCase()}_SERVICE_URL`)
      : `http://127.0.0.1:${developmentPorts[service]}`);
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      "x-internal-token": required("INTERNAL_TOKEN"),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`Internal ${service} request failed (${response.status})`);
  return response.json();
}
