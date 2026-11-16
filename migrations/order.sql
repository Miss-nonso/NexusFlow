CREATE TABLE orders (
  id uuid PRIMARY KEY, idempotency_key uuid NOT NULL UNIQUE, request_hash text NOT NULL,
  customer text NOT NULL, email text NOT NULL,
  items jsonb NOT NULL, amount int NOT NULL CHECK(amount>0), currency text NOT NULL CHECK(currency='usd'),
  status text NOT NULL CHECK(status IN ('PROCESSING','PAYMENT_PENDING','FULFILLED','CANCELLING','CANCELLED','DEAD_LETTER','REFUNDING','REFUNDED')),
  stage text NOT NULL, fault text NOT NULL DEFAULT 'none', failure jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, fulfilled_at timestamptz,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX orders_created ON orders(created_at DESC);
CREATE TABLE order_events (
  sequence bigserial PRIMARY KEY, event_id uuid UNIQUE NOT NULL, order_id uuid NOT NULL REFERENCES orders(id),
  name text NOT NULL, service text NOT NULL, occurred_at timestamptz NOT NULL, payload jsonb NOT NULL
);
CREATE INDEX order_events_order ON order_events(order_id,sequence);
