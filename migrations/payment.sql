CREATE TABLE payments (
  order_id uuid PRIMARY KEY, amount int NOT NULL CHECK(amount>0), currency text NOT NULL,
  provider text NOT NULL CHECK(provider IN ('mock','stripe')),
  status text NOT NULL CHECK(status IN ('CREATING','ACTION_REQUIRED','CAPTURED','FAILED','REFUND_PENDING','REFUNDED')),
  provider_id text UNIQUE, client_secret text,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_ledger (
  id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES payments(order_id),
  kind text NOT NULL CHECK(kind IN ('CAPTURED','FAILED','REFUNDED')),
  amount int NOT NULL CHECK(amount>0), currency text NOT NULL, provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(order_id,kind)
);
CREATE FUNCTION immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payment_ledger is append only'; END; $$;
CREATE TRIGGER payment_ledger_immutable BEFORE UPDATE OR DELETE ON payment_ledger FOR EACH ROW EXECUTE FUNCTION immutable_ledger();
CREATE TABLE stripe_webhooks (id text PRIMARY KEY, type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE refunds (
  order_id uuid PRIMARY KEY REFERENCES payments(order_id), provider_id text UNIQUE,
  job_id uuid NOT NULL, status text NOT NULL DEFAULT 'PENDING', created_at timestamptz NOT NULL DEFAULT now()
);
