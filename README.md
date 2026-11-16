# NexusFlow

A Dockerized distributed order-processing platform built with **Next.js 16 / React 19**, four independent service workers, **Apache Kafka**, **four PostgreSQL databases**, **Redis**, **Stripe Payment Intents**, and optional Prometheus/Grafana/Jaeger observability.

## Product overview

NexusFlow demonstrates how an online business can coordinate an order across inventory, payment, and fulfillment services while keeping a traceable record of each step. These workflows can fail between steps—for example, a payment may complete while fulfillment is unavailable. Durable events, retries, idempotency, and compensating actions help the system recover safely, such as releasing reserved stock when payment fails.

For e-commerce and logistics teams, this pattern helps protect against duplicate charges, lost orders, and inaccurate inventory, while giving operators visibility into stalled work and a way to retry it. The project is also a practical example of distributed systems, API design, data integrity, payment integration, and operational reliability.

## Current capabilities

- Admin dashboard to create and search recent orders, inspect status and event history, and monitor operational metrics and worker heartbeats.
- Kafka-driven order, inventory, payment, and fulfillment workers, each with its own PostgreSQL database.
- Atomic multi-item inventory reservations that prevent overselling.
- Durable outbox/inbox processing, HTTP idempotency, retry handling, and a dead-letter queue for failed deliveries.
- Failed-payment compensation that releases reserved inventory, plus operator-triggered retry for dead-lettered work.
- Local mock-payment mode and an optional Stripe flow with Payment Intents, secure card entry, signed webhooks, full refunds, and reconciliation.
- Docker Compose deployment, authenticated administration, and optional Prometheus, Grafana, and Jaeger observability.

The dashboard is an operations control plane, not a customer storefront. Stripe requires configured credentials; the default local payment provider is a mock adapter.

## Potential extensions

- Multi-user authentication, operator roles, and an audit trail for administrative actions.
- Customer storefront, order history, and shipment status tracking.
- Partial refunds, returns, tax calculation, and shipping-carrier booking.
- Multi-warehouse routing, backorders, and more advanced inventory policies.
- Production hardening with highly available Kafka, alerting, load testing, and tested backup and restore procedures.

**Project summary:** “I built a Dockerized order-processing platform that coordinates inventory, payments, and fulfillment through Kafka. It uses durable event handling, idempotent APIs, retries, and compensating workflows to make order processing observable and recoverable when services fail.”

## Start

Requires Docker Engine or Docker Desktop with Compose v2.20+, and Node.js 22+ for the credential-generation helper. Allocate at least 4 GB RAM; 6 GB is preferable with observability. First startup downloads images and builds the application.

```sh
node scripts/setup.mjs
# Start the complete application:
docker compose up -d --build
```

Open **http://localhost:8080**. Read `ADMIN_PASSWORD` from the generated project `.env` to sign in. The helper generates random credentials with file permissions `0600`; it never prints them or overwrites an existing file. Do not commit `.env`.

For Next.js hot reload while using the same local infrastructure, start the dependencies with `docker compose up -d`, then run `npm run dev` and open **http://localhost:3000**. Development defaults connect to the loopback-only Compose ports for PostgreSQL, Redis, and the workers. The production Compose web service continues to use the private Compose network.

If your selected Docker Desktop context is unavailable but the system Docker engine is running:

```sh
docker --context default compose up -d --build
# Or use the helper, which detects a working engine:
npm run docker:up
```

Default `PAYMENT_PROVIDER=mock` means **only the payment gateway is local**. Orders, reservations, ledger entries, shipment records, Kafka deliveries, outboxes, retries, and data persistence are real. The dashboard has no browser simulation engine. Stripe mode requires your keys, described below.

Stop containers without deleting data with `docker compose down`. Named volumes preserve databases, Redis, and Kafka across restarts. Never use `down -v` on data you need.

## Architecture

| Process | Owns | Responsibilities |
| --- | --- | --- |
| Next.js web/API | Order DB connection | Authenticated control plane, validation, server-owned prices, HTTP idempotency, order API, SSE |
| Order worker | Order PostgreSQL | Persisted saga state, command outbox, event timeline, compensation orchestration |
| Inventory worker | Inventory PostgreSQL | Multi-SKU reservations, sorted row locks, version checks, release/consume operations |
| Payment worker | Payment PostgreSQL | Local/Stripe adapter, append-only ledger, signed webhooks, settlement reconciliation, refunds |
| Fulfillment worker | Fulfillment PostgreSQL | Idempotent durable shipment/dispatch records and failed-delivery recovery |
| Kafka | Persistent event log | Six partitions keyed by order UUID, one consumer group per service, DLQ topic |
| Redis | Disposable operational state | Atomic rate limits, 24-hour idempotency response cache, expiring worker heartbeats |
| Nginx | HTTP ingress | Reverse proxy, request-size limits, SSE buffering disabled |

The workers are independently deployable Node.js/TypeScript processes, not NestJS wrappers. They share transport/schema utilities but **do not access one another's databases**. The API reads inventory and payment information through authenticated internal HTTP endpoints.

The happy path is:

```text
OrderCreated → ReserveInventory → InventoryReserved → CreatePayment
→ PaymentCaptured → FulfillOrder → ShipmentDispatched
→ CommitInventory → InventoryCommitted → FULFILLED
```

Stripe orders pause at `PAYMENT_PENDING` until the operator completes the secure Payment Element in the order inspector. A confirmed cancellation/expiry emits `PaymentFailed → ReleaseInventory → InventoryReleased → CANCELLED`. Card declines stay payable until cancellation or the 15-minute expiry; inventory is not released while a payment may still succeed.

A fulfilled order can be refunded once through the inspector or API. Refunds do **not** automatically restock a dispatched item. Returns/carrier integration are separate domain workflows; the fulfillment service currently records a dispatch, not a physical carrier booking.

## Reliability guarantees

- Order insertion and the initial outbox event commit in one PostgreSQL transaction.
- A UUID `Idempotency-Key` binds to a canonical request fingerprint. Replays return the original order; changed bodies return `409`. The DB uniqueness guarantee outlives the Redis cache.
- Browser retries retain request keys after ambiguous HTTP failures. Creating a deliberately new order gets a new key.
- Each service commits incoming Kafka messages to a durable inbox before acknowledging the offset. Inbox IDs deduplicate redelivery.
- Service mutations and outgoing events commit together. A database-scoped advisory lock serializes outbox relays across replicas. A crash after Kafka acknowledgement may publish a duplicate; consumers apply its business effect once.
- Sorted PostgreSQL row locks and conditional version updates make multi-SKU reservations atomic and prevent overselling. Redis lock expiry cannot compromise stock correctness because Redis is not the stock authority.
- Failed deliveries retry with exponential delay (2s, 4s), then enter a persistent DLQ after three failed attempts. Compensation and stock-commit failures are retryable too, not only fulfillment failures.
- Retrying a delivery resumes the original service operation. Payment capture and shipment records have unique order IDs, so a fulfillment retry cannot charge again.
- Stripe creates and refunds use stable, server-generated idempotency keys. Ambiguous operations older than 23 hours stop for reconciliation instead of risking reuse after Stripe's retention window.
- Webhook signatures are checked against raw bytes. Event IDs deduplicate webhooks; current Stripe state and amount/currency/order identity are checked before settlement. A periodic reconciler covers missed webhooks and expired unpaid intents.
- Financial ledger rows reject `UPDATE` and `DELETE`. Balances/status projections are separate mutable records.
- Delivery is **at least once**, with idempotent effects. This is not an end-to-end exactly-once claim.

## Stripe setup

1. In project `.env`, set:

   ```dotenv
   PAYMENT_PROVIDER=stripe
   STRIPE_SECRET_KEY=sk_test_your_key
   STRIPE_PUBLISHABLE_KEY=pk_test_your_key
   STRIPE_WEBHOOK_SECRET=whsec_your_signing_secret
   ```

2. Forward Stripe test events to the local webhook:

   ```sh
   stripe listen --forward-to localhost:8080/api/stripe/webhook \
     --events payment_intent.succeeded,payment_intent.canceled,refund.created,refund.updated,refund.failed
   ```

   Use the signing secret printed by your Stripe CLI as `STRIPE_WEBHOOK_SECRET`. Never paste secret keys into the UI or commit them.

3. Apply configuration with `docker compose up -d`. Create an order, open its inspector, and complete the Stripe Payment Element using Stripe test payment details. Refreshing the page does not lose the order.

4. For an externally reachable deployment, register the HTTPS `/api/stripe/webhook` URL in Stripe and use its endpoint-specific signing secret. A declined card remains retryable; unpaid intents expire after 15 minutes.

`ALLOW_LIVE_PAYMENTS=false` rejects live Stripe secret keys at startup. Real-money operation requires explicitly enabling it, using matching live keys, HTTPS, a live webhook endpoint, and your operational/payment compliance setup. No live charge is made by setup or tests.

Stripe API access cannot be validated without your credentials. Tests validate signatures, settlement transitions, amount matching, duplicate handling, and reconciliation safety locally; a real Stripe sandbox checkout is a separate verification step.

## APIs

All routes except health, login, session state, and the signature-protected Stripe webhook require an HttpOnly session or `Authorization: Bearer <ADMIN_API_TOKEN>`. Cookie-authenticated writes also require an exact `Origin` match to `APP_ORIGIN`. No application token is shipped in browser JavaScript.

| Method and path | Behavior |
| --- | --- |
| `GET /api/health` | Web DB/Redis readiness; does not disclose credentials |
| `POST /api/auth/login` | `{ "password": "..." }`, rate-limited |
| `POST /api/auth/logout` | Clears the session cookie |
| `GET /api/state?hours=1` | Latest 200 orders, catalog, all-time totals, real time buckets, service heartbeats |
| `GET /api/events` | Authenticated SSE change notifications; session expiry closes stream |
| `POST /api/orders` | Requires `Idempotency-Key` UUID; returns `202`, or `200` on replay |
| `GET /api/orders/:uuid` | Order state and full event trace |
| `GET /api/orders/:uuid/payment` | Authorized Stripe client secret for payment confirmation |
| `POST /api/orders/:uuid/retry` | Requeues a dead-letter delivery |
| `POST /api/orders/:uuid/refund` | Requests an idempotent full refund of a fulfilled order |
| `POST /api/stripe/webhook` | Raw Stripe webhook; verified by the payment service |

Order body (prices are looked up server-side, never accepted from clients):

```json
{
  "customer": "Example Customer",
  "email": "customer@example.com",
  "items": [{ "sku": "NF-KB-001", "quantity": 1 }],
  "fault": "none"
}
```

The current UI is an admin control plane, not a public storefront or multi-tenant user portal. It shows/searches the most recent 200 orders; aggregate metrics use the entire database. Direct order lookup by UUID is available for older records. Refunds created outside NexusFlow, partial refunds, returns, taxes, and shipping-carrier bookings require separate reconciliation/domain integrations; this API supports full refunds it creates.

## Fault injection and testing

Fault injection is disabled by default. For a local development stack, set `ALLOW_FAULT_INJECTION=true` and apply `docker compose up -d`. Use `fault: "payment"` with the local provider to test stock compensation, or `fault: "fulfillment"` to exhaust retries. Manual replay clears the injected fulfillment fault for that delivery. Stripe decline testing uses actual Stripe test cards, not the artificial payment fault.

```sh
npm ci
npm test
npm run typecheck
npm run build
# Builds an isolated nexusflow-test Compose project, enables faults only there,
# and runs real API/Kafka/PostgreSQL/Redis integration tests:
npm run test:docker
# Against the running local-provider stack, temporarily restart services/Kafka:
npm run test:resilience
```

The test project has separate named volumes and no published app/database ports. It forces the local payment provider even when the main `.env` selects Stripe. Tests create clearly named fixture orders/SKUs; they never reset the main stack. Temporary schemas used for low-level crash/concurrency tests are deleted by those tests.

Integration coverage includes concurrent HTTP idempotency, mismatched-body rejection, oversell contention, multi-item atomicity, failed-payment compensation, DLQ retry without double capture, refunds, immutable ledger enforcement, outbox acknowledgement rollback, inbox deduplication, and Stripe settlement/signature replay.

To remove only the completed test project's fixtures, use the explicitly scoped project command when you no longer need them:

```sh
docker compose -p nexusflow-test -f compose.yaml -f compose.test.yaml down -v
```

## Observability

```sh
# Set OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 in .env first.
docker compose --profile observability up -d
```

- Grafana: **http://localhost:3001**, user `admin`, password `ADMIN_PASSWORD`.
- Prometheus: **http://localhost:9090**.
- Jaeger: **http://localhost:16686**.
- Each worker exposes `/health` and Prometheus `/metrics` internally. Metrics include unpublished outbox depth, pending/dead/processed deliveries, poison-message count, Kafka consumer lag, and order-duration histogram.
- OpenTelemetry spans carry trace context from HTTP through Kafka and downstream handling. Logs include event/order IDs and bounded error classes, not payment secrets or request bodies.

## Deployment boundaries

The images are production builds, run as non-root users, and use health checks and graceful shutdown. The local Compose topology is intentionally a **single-host development/reference deployment**, not a highly available production cluster.

Before public production use, provide TLS ingress (`APP_ORIGIN=https://...`, `SECURE_COOKIES=true`), an identity provider/MFA instead of the single-admin password, secret management and rotation, backups/PITR with tested restores, multi-broker Kafka replication, broker TLS/SASL and ACLs, network segmentation, database TLS and capacity tuning, alert routing, and retention policies for outbox/inbox/audit data. Kafka remains internal; Redis, databases, worker ports, the app, and observability endpoints are bound to loopback for local development and are not exposed on external interfaces by the default Compose setup.

The PostgreSQL bootstrap account is separate from the application role. Application roles are database owners for migrations but are not superusers; larger deployments should split migration ownership from restricted runtime grants. Redis is authenticated and configured for AOF persistence, while PostgreSQL remains the source of truth.

The earlier Sites URL remains the static prototype. This server application is deployed with Docker; Sites' static hosting cannot run its Kafka/PostgreSQL service topology.
