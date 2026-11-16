CREATE TABLE shipments (
  order_id uuid PRIMARY KEY, reference text UNIQUE NOT NULL, items jsonb NOT NULL,
  status text NOT NULL DEFAULT 'DISPATCHED', created_at timestamptz NOT NULL DEFAULT now()
);
