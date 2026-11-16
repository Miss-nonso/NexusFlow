CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS outbox (
  sequence bigserial PRIMARY KEY, id uuid UNIQUE NOT NULL, aggregate_id uuid NOT NULL,
  topic text NOT NULL, event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(sequence) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS inbox (
  id uuid PRIMARY KEY, sequence bigserial UNIQUE NOT NULL, aggregate_id uuid NOT NULL, event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE','DEAD')),
  attempts int NOT NULL DEFAULT 0, manual_retries int NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, last_error text
);
CREATE INDEX IF NOT EXISTS inbox_ready ON inbox(available_at) WHERE status='PENDING';
CREATE TABLE IF NOT EXISTS dead_letters (
  id uuid PRIMARY KEY, event jsonb NOT NULL, error text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz
);
CREATE TABLE IF NOT EXISTS poison_messages (
  topic text NOT NULL, partition int NOT NULL, offset_value text NOT NULL,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(topic,partition,offset_value)
);
