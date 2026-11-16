export type Fault = "none" | "payment" | "fulfillment";
export type Status =
  | "PROCESSING"
  | "PAYMENT_PENDING"
  | "FULFILLED"
  | "CANCELLING"
  | "CANCELLED"
  | "DEAD_LETTER"
  | "REFUNDING"
  | "REFUNDED";
export type Order = {
  id: string;
  key: string;
  customer: string;
  email: string;
  items: { sku: string; quantity: number; unitPrice: number }[];
  sku: string;
  quantity: number;
  amount: number;
  status: Status;
  stage: string;
  fault: Fault;
  created: number;
  duration: number;
  events: { name: string; service: string; time: number; payload?: unknown }[];
};
export type Stock = {
  sku: string;
  name: string;
  price: number;
  available: number;
  reserved: number;
  version: number;
};
export type Snapshot = {
  orders: Order[];
  stock: Stock[];
  totals: {
    total: number;
    fulfilled: number;
    cancelled: number;
    dead: number;
    processing: number;
    refunded: number;
    revenue: number;
    latency: number;
  };
  series: number[];
  services: { name: string; healthy: boolean }[];
  provider: "mock" | "stripe";
  faultInjection: boolean;
  inventoryAvailable: boolean;
  publishableKey: string;
  time: number;
};
export const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  );
