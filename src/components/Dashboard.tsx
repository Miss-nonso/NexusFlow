"use client";
import { useEffect, useState, useMemo, useRef, type ReactNode } from "react";
import { api, useControlPlane } from "./control-plane";
import dynamic from "next/dynamic";
const Payment = dynamic(
  () => import("./Payment").then((module) => module.Payment),
  { ssr: false },
);
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Box,
  Boxes,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  CreditCard,
  Database,
  Filter,
  GitBranch,
  Layers,
  LayoutDashboard,
  Link2,
  Network,
  Package,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  ShoppingBag,
  Terminal,
  TriangleAlert,
  Truck,
  X,
  Zap,
} from "lucide-react";
import { money, type Order, type Fault } from "../contracts";

const nav = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Orders", icon: ShoppingBag },
  { name: "Saga explorer", icon: GitBranch },
  { name: "Inventory", icon: Boxes },
  { name: "Payments", icon: CreditCard },
  { name: "Dead-letter queue", icon: Layers },
];
const statusLabel = {
  FULFILLED: "Fulfilled",
  PROCESSING: "Processing",
  PAYMENT_PENDING: "Awaiting payment",
  CANCELLING: "Compensating",
  REFUNDING: "Refunding",
  REFUNDED: "Refunded",
  CANCELLED: "Cancelled",
  DEAD_LETTER: "Dead letter",
};
function Status({ value }: { value: Order["status"] }) {
  return (
    <span className={"status " + value.toLowerCase()}>
      <i />
      {statusLabel[value]}
    </span>
  );
}
function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export default function Dashboard({
  onLogout,
}: {
  onLogout: () => Promise<void>;
}) {
  const [page, setPage] = useState("Overview"),
    [live, setLive] = useState(true),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("ALL"),
    [selected, setSelected] = useState<string | null>(null),
    [modal, setModal] = useState(false),
    [count, setCount] = useState(1),
    [fault, setFault] = useState<Fault>("none"),
    [range, setRange] = useState("1H"),
    [toast, setToast] = useState(""),
    [showPayload, setShowPayload] = useState(false);
  const [customer, setCustomer] = useState(""),
    [email, setEmail] = useState(""),
    [sku, setSku] = useState(""),
    [quantity, setQuantity] = useState(1),
    [busy, setBusy] = useState(false);
  const { state, error, connected, refresh } = useControlPlane(
    live,
    Number(range.replace("H", "")),
  );
  const pendingBatch = useRef<{ signature: string; keys: string[] } | null>(
    null,
  );
  const series = state.series,
    chartMax = Math.max(4, ...series);
  useEffect(() => {
    if (!sku && state.stock.length) setSku(state.stock[0].sku);
  }, [state.stock, sku]);
  async function action(fn: () => Promise<unknown>, message: string) {
    try {
      await fn();
      await refresh();
      setToast(message);
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(""), 4000);
      return () => clearTimeout(id);
    }
  }, [toast]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal(false);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  useEffect(() => {
    if (!modal && !selected) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,[tabindex="0"]',
        ) || [],
      );
    focusable()[0]?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      document.body.style.overflow = oldOverflow;
      previous?.focus();
    };
  }, [modal, selected]);
  const fulfilled = state.orders.filter((o) => o.status === "FULFILLED"),
    dlq = state.orders.filter((o) => o.status === "DEAD_LETTER"),
    processing = state.orders.filter((o) => o.status === "PROCESSING"),
    cancelled = state.orders.filter((o) => o.status === "CANCELLED");
  const orders = useMemo(
    () =>
      state.orders.filter(
        (o) =>
          (filter === "ALL" || o.status === filter) &&
          `${o.id} ${o.customer} ${o.email}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [state.orders, query, filter],
  );
  const active = state.orders.find((o) => o.id === selected),
    success = (
      ((state.totals.fulfilled + state.totals.refunded) /
        Math.max(1, state.totals.total - state.totals.processing)) *
      100
    ).toFixed(1),
    revenue = state.totals.revenue;
  const notify = (s: string) => setToast(s);
  async function run() {
    if (!customer.trim() || !email.includes("@") || !sku) {
      notify("Enter a customer name, email, and product.");
      return;
    }
    setBusy(true);
    const signature = JSON.stringify({
      customer,
      email,
      sku,
      quantity,
      count,
      fault,
    });
    if (pendingBatch.current?.signature !== signature)
      pendingBatch.current = {
        signature,
        keys: Array.from(
          { length: state.provider === "stripe" ? 1 : count },
          () => crypto.randomUUID(),
        ),
      };
    let created = 0;
    try {
      for (let i = 0; i < (state.provider === "stripe" ? 1 : count); i++) {
        await api("orders", {
          method: "POST",
          headers: { "Idempotency-Key": pendingBatch.current!.keys[i] },
          body: JSON.stringify({
            customer,
            email,
            items: [{ sku, quantity }],
            fault: state.faultInjection && i % 3 === 0 ? fault : "none",
          }),
        });
        created++;
      }
      pendingBatch.current = null;
      setLive(true);
      setModal(false);
      await refresh();
      notify(`${created} orders accepted for processing`);
    } catch (e) {
      notify(`${created} accepted. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  function exportOrders() {
    const blob = new Blob([JSON.stringify(state.orders, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nexusflow-orders.json";
    a.click();
    URL.revokeObjectURL(url);
    notify("Order data exported");
  }
  function table(list: Order[], compact = false) {
    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Amount</th>
              <th>Duration</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.slice(0, compact ? 6 : 100).map((o) => (
              <tr
                key={o.id}
                onClick={() => {
                  setSelected(o.id);
                  setShowPayload(false);
                }}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setSelected(o.id);
                }}
                aria-label={`Inspect order ${o.id}`}
              >
                <td className="order-id">
                  <span title={o.id}>{o.id.slice(0, 8)}</span>
                  <ArrowUpRight size={12} />
                </td>
                <td>
                  <div className="customer">{o.customer}</div>
                  <div className="email">{o.email}</div>
                </td>
                <td>
                  <Status value={o.status} />
                </td>
                <td className="mono">{money(o.amount)}</td>
                <td className="muted mono">
                  {o.status === "PROCESSING" ? (
                    <span className="working">In progress</span>
                  ) : (
                    `${(o.duration / 1000).toFixed(2)}s`
                  )}
                </td>
                <td className="muted">
                  {new Date(o.created).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </td>
                <td>
                  <ChevronRight size={15} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && (
          <div className="empty">
            <Search size={24} />
            <h3>No orders found</h3>
            <p>Try another search or create an order.</p>
          </div>
        )}
      </div>
    );
  }
  function toolbar() {
    return (
      <div className="table-toolbar">
        <div className="input-icon">
          <Search size={15} />
          <input
            aria-label="Search orders"
            placeholder="Search orders, customers..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="select-wrap">
          <Filter size={14} />
          <select
            aria-label="Filter order status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="ALL">All statuses</option>
            {Object.entries(statusLabel).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("Overview");
          }}
        >
          <div className="brand-mark">
            <Layers size={23} />
          </div>
          NexusFlow<span className="version">v1.0</span>
        </a>
        <button
          className="workspace"
          onClick={() =>
            notify(`Connected backend · ${state.provider} payments`)
          }
        >
          <div className="workspace-icon">
            <Box size={19} />
          </div>
          <span>
            NexusFlow workspace<small>Engineering team</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.name}
              aria-label={n.name}
              title={n.name}
              className={page === n.name ? "nav-item active" : "nav-item"}
              onClick={() => {
                setPage(n.name);
                setQuery("");
                setFilter("ALL");
              }}
            >
              <n.icon size={18} />
              <span>{n.name}</span>
              {n.name === "Dead-letter queue" && (
                <b className="nav-count">{dlq.length}</b>
              )}
              {n.name === "Overview" && <span className="active-dot" />}
            </button>
          ))}
        </nav>
        <div className="nav-label tools-label">DEVELOPMENT</div>
        <button
          className="nav-item"
          aria-label="Order lab"
          title="Order lab"
          onClick={() => setModal(true)}
        >
          <Terminal size={18} />
          <span>Order lab</span>
          <span className="beta">LAB</span>
        </button>
        <button
          className="nav-item"
          aria-label="Architecture"
          title="Architecture"
          onClick={() => setPage("Architecture")}
        >
          <Network size={18} />
          <span>Architecture</span>
        </button>
        <div className="sidebar-bottom">
          <div className="environment-card">
            <div>
              <span className="green-dot" />
              {connected ? "Backend connected" : "Backend disconnected"}
            </div>
            <p>PostgreSQL · Kafka · Redis</p>
            <div className="env-foot">
              <span>docker-services</span>
              <Radio size={13} />
            </div>
          </div>
          <button
            className="profile"
            onClick={() => void action(onLogout, "Signed out")}
          >
            <div className="avatar">AD</div>
            <span>
              Admin<small>Sign out</small>
            </span>
            <ChevronDown size={14} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            <span className="sandbox-label">
              <span className="green-dot" />
              {state.provider === "stripe" ? "Stripe" : "Local payments"}
              <ChevronDown size={12} />
            </span>
            <span className="vertical-line" />
            <button
              className="docs-link"
              onClick={() => setPage("Architecture")}
            >
              Documentation
              <ArrowUpRight size={13} />
            </button>
            <div className="avatar small">AD</div>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                CONTROL PLANE <span>/</span>{" "}
                {page === "Overview" ? "SYSTEM OVERVIEW" : page.toUpperCase()}
              </div>
              <h1>{page === "Overview" ? "Everything in flow." : page}</h1>
              <p>
                {page === "Overview"
                  ? "Your distributed system, at a glance. Every order. Every service. Every event."
                  : page === "Orders"
                    ? "Follow each order from creation to fulfillment."
                    : page === "Saga explorer"
                      ? "Inspect forward actions, compensation, and distributed transaction state."
                      : page === "Inventory"
                        ? "Stock reservations with versioned updates and oversell protection."
                        : page === "Payments"
                          ? "An event-derived view of captures and declines."
                          : page === "Dead-letter queue"
                            ? "Inspect failed deliveries and resume fulfillment safely."
                            : "The services and guarantees behind NexusFlow."}
              </p>
            </div>
            <div className="heading-actions">
              <button className="button" onClick={exportOrders}>
                <ArrowDownLeft size={15} />
                Export recent orders
              </button>
              <button className="button primary" onClick={() => setModal(true)}>
                <Zap size={15} />
                Create order
              </button>
            </div>
          </div>
          <div className="system-strip">
            <div>
              <span className="green-dot" />
              <strong>
                {connected &&
                state.services.every((s) => s.healthy) &&
                state.services.length === 4
                  ? "All services connected"
                  : "Waiting for healthy services"}
              </strong>
              <span className="strip-separator">/</span>
              <span>
                {state.services.filter((s) => s.healthy).length} / 4 workers
                healthy
              </span>
            </div>
            <div>
              <span className="demo-tag">
                {state.provider === "mock" ? "LOCAL PAYMENTS" : "STRIPE"}
              </span>
              <span className="strip-time">
                Updated {live ? "in real time" : "· paused"}
              </span>
              <button
                className={"live-toggle " + (live ? "on" : "")}
                onClick={() => setLive(!live)}
              >
                {live ? <Pause size={11} /> : <Play size={11} />}{" "}
                {live ? "Live" : "Paused"}
              </button>
            </div>
          </div>
          {error && (
            <div className="connection-error" role="alert">
              {error}{" "}
              <button onClick={() => void refresh()}>Retry connection</button>
            </div>
          )}
          {page === "Overview" && (
            <>
              <div className="metrics">
                <Metric
                  title="Total orders"
                  value={state.totals.total.toLocaleString()}
                  icon={<ShoppingBag size={17} />}
                  trend={`${state.totals.processing} processing`}
                  note="persisted orders"
                  data={[9, 11, 8, 13, 12, 19, 18, 24, 23, 29, 27, 35]}
                />
                <Metric
                  title="Success rate"
                  value={success}
                  suffix="%"
                  icon={<CheckCheck size={17} />}
                  trend={`${state.totals.fulfilled} fulfilled`}
                  note={`${state.totals.cancelled} compensated / rejected`}
                  data={[25, 24, 26, 25, 27, 26, 28, 25, 27, 29, 27, 29]}
                />
                <Metric
                  title="Avg. processing time"
                  value={(state.totals.latency / 1000).toFixed(2)}
                  suffix="s"
                  icon={<Clock size={17} />}
                  trend="End-to-end latency"
                  note="completed transactions"
                  data={[29, 25, 27, 18, 22, 19, 20, 15, 19, 13, 15, 11]}
                />
                <Metric
                  title="Dead-letter queue"
                  value={String(state.totals.dead)}
                  icon={<Layers size={17} />}
                  trend={
                    dlq.length ? "Needs your attention" : "No failed deliveries"
                  }
                  note="available for reprocessing"
                  amber
                  data={[4, 4, 4, 4, 4, 4, 12, 12, 12, 12, 12, 12]}
                />
              </div>
              <div className="overview-grid">
                <section className="panel throughput">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        Order throughput{" "}
                        <span
                          className="help-dot"
                          title="Order arrivals from PostgreSQL in 48 equal time buckets."
                        >
                          i
                        </span>
                      </h2>
                      <p>Persisted orders · 48 time buckets</p>
                    </div>
                    <div className="segmented">
                      {["1H", "6H", "24H"].map((r) => (
                        <button
                          key={r}
                          className={range === r ? "chosen" : ""}
                          onClick={() => setRange(r)}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="chart-summary">
                    <strong>
                      {series[series.length - 1]}
                      <span>orders / interval</span>
                    </strong>
                    <span className="chart-legend">
                      <i />
                      Created orders
                    </span>
                  </div>
                  <div className="chart">
                    <div className="y-labels">
                      {[1, 0.75, 0.5, 0.25, 0].map((n) => (
                        <span key={n}>{Math.ceil(chartMax * n)}</span>
                      ))}
                    </div>
                    <div className="chart-main">
                      <svg
                        viewBox="0 0 600 150"
                        preserveAspectRatio="none"
                        role="img"
                        aria-label={`${range} order throughput chart`}
                      >
                        <defs>
                          <linearGradient
                            id="chart-fill"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor="#b6ed82"
                              stopOpacity=".2"
                            />
                            <stop
                              offset="100%"
                              stopColor="#b6ed82"
                              stopOpacity="0"
                            />
                          </linearGradient>
                        </defs>
                        {[0, 37.5, 75, 112.5, 150].map((y) => (
                          <line
                            key={y}
                            x1="0"
                            x2="600"
                            y1={y}
                            y2={y}
                            stroke="#262d33"
                            strokeDasharray="3 5"
                          />
                        ))}
                        <path
                          d={`M0,150 ${series.map((v, i) => `L${(i * 600) / 47},${150 - (v / chartMax) * 145}`).join(" ")} L600,150 Z`}
                          fill="url(#chart-fill)"
                        />
                        <polyline
                          points={series
                            .map(
                              (v, i) =>
                                `${(i * 600) / 47},${150 - (v / chartMax) * 145}`,
                            )
                            .join(" ")}
                          fill="none"
                          stroke="#b6ed82"
                          strokeWidth="2"
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                      <div className="x-labels">
                        {(range === "1H"
                          ? [
                              "−60 min",
                              "−50 min",
                              "−40 min",
                              "−30 min",
                              "−20 min",
                              "−10 min",
                              "Now",
                            ]
                          : range === "6H"
                            ? ["−6h", "−5h", "−4h", "−3h", "−2h", "−1h", "Now"]
                            : [
                                "−24h",
                                "−20h",
                                "−16h",
                                "−12h",
                                "−8h",
                                "−4h",
                                "Now",
                              ]
                        ).map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="chart-footer">
                    <span>
                      <span className="green-dot" />
                      {connected
                        ? "API stream connected"
                        : "API stream disconnected"}
                    </span>
                    <span>
                      Partition key <code>order_id</code>
                      <Link2 size={12} />
                    </span>
                  </div>
                </section>
                <section className="panel health">
                  <div className="panel-heading">
                    <div>
                      <h2>Service health</h2>
                      <p>Independent services. One flow.</p>
                    </div>
                    <span className="subtle-tag">
                      {state.services.filter((s) => s.healthy).length} / 4
                    </span>
                  </div>
                  <div className="service-list">
                    {[
                      {
                        name: "Order service",
                        desc: "Requests & transactional outbox",
                        icon: ShoppingBag,
                        latency: 12,
                      },
                      {
                        name: "Inventory service",
                        desc: "Reservations & stock control",
                        icon: Boxes,
                        latency: 8,
                      },
                      {
                        name: "Payment service",
                        desc: "Captures & compensation",
                        icon: CreditCard,
                        latency: 24,
                      },
                      {
                        name: "Fulfillment service",
                        desc: "Orchestration & delivery",
                        icon: Truck,
                        latency: 16,
                      },
                    ].map((s, i) => (
                      <div className="service" key={s.name}>
                        <div className={"service-icon service-" + i}>
                          <s.icon size={17} />
                        </div>
                        <div className="service-title">
                          {s.name}
                          <small>{s.desc}</small>
                        </div>
                        <div className="service-state">
                          <span>
                            <i />
                            {state.services[i]?.healthy
                              ? "Healthy"
                              : "Unavailable"}
                          </span>
                          <small>heartbeat</small>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button
                    className="panel-link"
                    onClick={() => setPage("Architecture")}
                  >
                    Explore service topology
                    <ArrowRight size={14} />
                  </button>
                </section>
              </div>
              <section className="panel orders-panel">
                <div className="panel-heading">
                  <div className="inline-heading">
                    <h2>Live orders</h2>
                    <span className="count-tag">{state.orders.length}</span>
                    <span className="live-caption">
                      <i />
                      {live ? "Streaming" : "Paused"}
                    </span>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setPage("Orders")}
                  >
                    View all orders
                    <ArrowRight size={14} />
                  </button>
                </div>
                {toolbar()}
                {table(orders, true)}
                <div className="table-footer">
                  <span>
                    Showing {Math.min(6, orders.length)} of {orders.length}{" "}
                    orders
                  </span>
                  <span>
                    <ShieldCheck size={13} />
                    Idempotency protected
                  </span>
                </div>
              </section>
              <div className="bottom-grid">
                <section className="panel pipeline">
                  <div className="panel-heading">
                    <h2>The order lifecycle</h2>
                    <span className="subtle-tag">SAGA PATTERN</span>
                  </div>
                  <div className="lifecycle">
                    {[
                      { name: "Created", icon: ShoppingBag },
                      { name: "Reserved", icon: Boxes },
                      { name: "Paid", icon: CreditCard },
                      { name: "Fulfilled", icon: Package },
                    ].map((s, i) => (
                      <div className="lifecycle-item" key={s.name}>
                        <div>
                          <s.icon size={18} />
                        </div>
                        <span>{s.name}</span>
                        {i < 3 && (
                          <ArrowRight className="flow-arrow" size={16} />
                        )}
                      </div>
                    ))}
                  </div>
                  <p>Durable events. Explicit compensation. Safe retries.</p>
                </section>
                <section className="lab-card">
                  <div className="lab-icon">
                    <Terminal size={21} />
                  </div>
                  <div>
                    <span className="eyebrow">BUILT TO BE TESTED</span>
                    <h2>Break things. Watch them recover.</h2>
                    <p>
                      Inject traffic and service failures. See resilience in
                      action.
                    </p>
                    <button
                      className="text-button"
                      onClick={() => setModal(true)}
                    >
                      Open order lab
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </section>
              </div>
            </>
          )}
          {page === "Orders" && (
            <section className="panel">
              {toolbar()}
              {table(orders)}
              <div className="table-footer">
                {orders.length > 100
                  ? `Showing latest 100 of ${orders.length}`
                  : `${orders.length} orders`}{" "}
                · Select a row to inspect its saga.
              </div>
            </section>
          )}
          {page === "Saga explorer" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Distributed transactions</h2>
                  <p>Select an order to inspect its complete event timeline.</p>
                </div>
                <GitBranch size={20} />
              </div>
              {toolbar()}
              {table(orders)}
            </section>
          )}
          {page === "Inventory" && (
            <div className="inventory-grid">
              {state.stock.map((s) => (
                <section className="panel inventory-card" key={s.sku}>
                  <div className="inventory-icon">
                    <Package size={26} />
                  </div>
                  <code>{s.sku}</code>
                  <h2>{s.name}</h2>
                  <p>{money(s.price)} per unit</p>
                  <div className="stock-numbers">
                    <div>
                      <strong>{s.available}</strong>
                      <span>Available</span>
                    </div>
                    <div>
                      <strong>{s.reserved}</strong>
                      <span>Reserved</span>
                    </div>
                  </div>
                  <div className="stock-bar">
                    <span
                      style={{
                        width: `${(s.available / (s.available + s.reserved)) * 100}%`,
                      }}
                    />
                  </div>
                  <div className="table-footer">
                    <span>OCC version {s.version}</span>
                    <ShieldCheck size={15} />
                  </div>
                  <button
                    className="button full"
                    onClick={() => {
                      setSku(s.sku);
                      setModal(true);
                    }}
                  >
                    <Plus size={14} />
                    Create order
                  </button>
                </section>
              ))}
            </div>
          )}
          {page === "Payments" && (
            <>
              <div className="metrics three">
                <Metric
                  title="Fulfilled order value"
                  value={money(revenue)}
                  icon={<CreditCard size={17} />}
                  trend="Currency: USD"
                  note={
                    state.provider === "mock"
                      ? "local payment provider"
                      : "Stripe payment provider"
                  }
                  data={[4, 6, 8, 5, 12, 15, 13, 21]}
                />
                <Metric
                  title="Captured payments"
                  value={String(
                    state.orders.filter((o) =>
                      o.events.some((e) => e.name === "PaymentCaptured"),
                    ).length,
                  )}
                  icon={<Check size={17} />}
                  trend="One capture per order"
                  note="integer-cent amounts"
                  data={[4, 6, 8, 5, 12, 15, 13, 21]}
                />
                <Metric
                  title="Declined payments"
                  value={String(
                    state.orders.filter((o) =>
                      o.events.some((e) => e.name === "PaymentDeclined"),
                    ).length,
                  )}
                  icon={<TriangleAlert size={17} />}
                  trend="Reservations released"
                  note="automatic compensation"
                  amber
                  data={[4, 4, 5, 5, 5, 7, 7, 7]}
                />
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Payment activity</h2>
                  <span className="demo-tag">PAYMENT ACTIVITY</span>
                </div>
                {table(
                  state.orders.filter((o) =>
                    o.events.some((e) => e.service === "payment-service"),
                  ),
                )}
              </section>
            </>
          )}
          {page === "Dead-letter queue" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    Failed deliveries{" "}
                    <span className="count-tag">{dlq.length}</span>
                  </h2>
                  <p>
                    Retries resume the failed service operation. Inspect the
                    trace before replaying.
                  </p>
                </div>
                <button
                  className="button"
                  disabled={!dlq.length}
                  onClick={() =>
                    void action(async () => {
                      for (const o of dlq)
                        await api(`orders/${o.id}/retry`, { method: "POST" });
                      setLive(true);
                    }, "Dead-letter deliveries queued for retry")
                  }
                >
                  <RefreshCw size={14} />
                  Retry all
                </button>
              </div>
              {dlq.length ? (
                table(dlq)
              ) : (
                <div className="empty">
                  <CheckCheck size={30} />
                  <h3>Queue is clear</h3>
                  <p>All failed deliveries have been recovered.</p>
                  <button
                    className="button"
                    onClick={() => {
                      setFault("fulfillment");
                      setModal(true);
                    }}
                  >
                    Simulate a delivery failure
                  </button>
                </div>
              )}
            </section>
          )}
          {page === "Architecture" && (
            <section className="panel architecture">
              <div className="panel-heading">
                <div>
                  <h2>Designed for eventual consistency</h2>
                  <p>
                    Independent workers exchange Kafka events and commit their
                    own PostgreSQL transactions.
                  </p>
                </div>
                <Network size={22} />
              </div>
              <div className="topology">
                <div className="topology-node">
                  <LayoutDashboard />
                  <strong>React control plane</strong>
                  <small>Authenticated Next.js dashboard & APIs</small>
                </div>
                <div className="connector-line" />
                <div className="topology-node broker">
                  <Activity />
                  <strong>Event bus</strong>
                  <small>Apache Kafka · partition key: order_id</small>
                </div>
                <div className="topology-services">
                  {["Order", "Inventory", "Payment", "Fulfillment"].map((s) => (
                    <div className="topology-node" key={s}>
                      <Server size={21} />
                      <strong>{s} service</strong>
                      <small>Isolated responsibility</small>
                      <Database size={16} />
                    </div>
                  ))}
                </div>
              </div>
              <div className="architecture-notes">
                <div>
                  <ShieldCheck />
                  <h3>Idempotent operations</h3>
                  <p>
                    Repeated request keys do not create additional orders.
                    Fulfillment retries never recapture a payment.
                  </p>
                </div>
                <div>
                  <GitBranch />
                  <h3>Compensating transactions</h3>
                  <p>
                    A payment decline releases the reservation. Delivery
                    failures remain in the DLQ until retried.
                  </p>
                </div>
                <div>
                  <Code2 />
                  <h3>Production integration</h3>
                  <p>
                    Next.js serves the admin APIs. Separate Node.js workers own
                    PostgreSQL databases, outboxes, and durable inboxes. Redis
                    provides rate limits and heartbeats; Stripe handles payments
                    when configured.
                  </p>
                </div>
              </div>
            </section>
          )}
          <footer className="main-footer">
            <span>
              <Layers size={13} />
              NexusFlow <span className="footer-separator">/</span> Distributed
              by design.
            </span>
            <span>
              <span className="green-dot" />
              {state.provider === "mock"
                ? "Local payments"
                : "Stripe payments"}{" "}
              <span className="footer-separator">·</span> Durable PostgreSQL
              storage
            </span>
          </footer>
        </main>
      </div>
      {selected && active && (
        <div className="overlay" onClick={() => setSelected(null)}>
          <section
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Order saga trace"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-top">
              <span className="eyebrow">DISTRIBUTED TRANSACTION</span>
              <IconButton
                label="Close inspector"
                onClick={() => setSelected(null)}
              >
                <X size={20} />
              </IconButton>
            </div>
            <h1>{active.id}</h1>
            <div className="drawer-sub">
              <Status value={active.status} />
              <span>{money(active.amount)}</span>
            </div>
            <div className="detail-grid">
              <div>
                Customer<strong>{active.customer}</strong>
              </div>
              <div>
                Product
                <strong>
                  {active.sku} × {active.quantity}
                </strong>
              </div>
              <div>
                Idempotency key<strong>{active.key}</strong>
              </div>
              <div>
                Processing time
                <strong>{(active.duration / 1000).toFixed(2)}s</strong>
              </div>
            </div>
            <h2 className="timeline-title">
              <GitBranch size={18} />
              Saga timeline
            </h2>
            <div className="timeline">
              {active.events.map((e, i) => (
                <div
                  className={
                    "timeline-event " +
                    (/Declined|Rejected|Exhausted/.test(e.name)
                      ? "failed"
                      : /Released|Retry/.test(e.name)
                        ? "compensated"
                        : "")
                  }
                  key={i}
                >
                  <div className="timeline-point">
                    {/Declined|Rejected|Exhausted/.test(e.name) ? (
                      <X size={14} />
                    ) : (
                      <Check size={14} />
                    )}
                  </div>
                  <div>
                    <strong>{e.name}</strong>
                    <span>{e.service}</span>
                    <small>
                      +{((e.time - active.created) / 1000).toFixed(3)}s
                    </small>
                  </div>
                </div>
              ))}
              {active.status === "PROCESSING" && (
                <div className="timeline-event pending">
                  <div className="timeline-point">
                    <Clock size={14} />
                  </div>
                  <div>
                    <strong>Awaiting next event</strong>
                    <span>{live ? "Processing…" : "Stream paused"}</span>
                  </div>
                </div>
              )}
            </div>
            {active.status === "PAYMENT_PENDING" && (
              <div className="payment-panel">
                <h2>Complete payment</h2>
                <Payment
                  orderId={active.id}
                  publishableKey={state.publishableKey}
                  onComplete={() => {
                    void refresh();
                    notify("Payment submitted. Waiting for settlement.");
                  }}
                />
              </div>
            )}
            {active.status === "FULFILLED" && (
              <button
                className="button full"
                onClick={() => {
                  if (
                    window.confirm(
                      `Refund ${money(active.amount)} for this order?`,
                    )
                  )
                    void action(
                      () =>
                        api(`orders/${active.id}/refund`, { method: "POST" }),
                      "Refund requested",
                    );
                }}
              >
                Refund {money(active.amount)}
              </button>
            )}
            {active.status === "DEAD_LETTER" && (
              <button
                className="button primary full"
                onClick={() =>
                  void action(
                    () => api(`orders/${active.id}/retry`, { method: "POST" }),
                    "Delivery retry queued",
                  )
                }
              >
                <RefreshCw size={15} />
                Retry delivery
              </button>
            )}
            <button
              className="button full payload-button"
              onClick={() => setShowPayload(!showPayload)}
            >
              <Code2 size={15} />
              {showPayload ? "Hide" : "Inspect"} event payload
              <ChevronDown size={14} />
            </button>
            {showPayload && <pre>{JSON.stringify(active, null, 2)}</pre>}
            <button
              className="text-button duplicate-button"
              onClick={() =>
                void action(
                  () =>
                    api("orders", {
                      method: "POST",
                      headers: { "Idempotency-Key": active.key },
                      body: JSON.stringify({
                        customer: active.customer,
                        email: active.email,
                        items: active.items.map((i) => ({
                          sku: i.sku,
                          quantity: i.quantity,
                        })),
                        fault: active.fault,
                      }),
                    }),
                  "Original order returned; no duplicate created",
                )
              }
            >
              <ShieldCheck size={14} />
              Test duplicate request
            </button>
          </section>
        </div>
      )}
      {modal && (
        <div className="overlay modal-overlay" onClick={() => setModal(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="simulation-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-top">
              <div className="lab-icon">
                <Terminal size={22} />
              </div>
              <IconButton
                label="Close simulation"
                onClick={() => setModal(false)}
              >
                <X size={20} />
              </IconButton>
            </div>
            <span className="eyebrow">ORDER LAB</span>
            <h1 id="simulation-title">Create an order.</h1>
            <p>
              Orders flow through the real services and persist across restarts.
            </p>
            <label className="field-label" htmlFor="customer">
              Customer name
            </label>
            <input
              id="customer"
              className="fault-select"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              maxLength={120}
            />
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className="fault-select"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label className="field-label" htmlFor="sku">
              Product
            </label>
            <select
              id="sku"
              className="fault-select"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
            >
              {state.stock.map((s) => (
                <option key={s.sku} value={s.sku}>
                  {s.name} · {money(s.price)}
                </option>
              ))}
            </select>
            <label className="field-label" htmlFor="quantity">
              Quantity
            </label>
            <input
              id="quantity"
              type="number"
              min="1"
              max="100"
              className="fault-select"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
            <label className="field-label" htmlFor="order-count">
              Orders in batch <strong>{count}</strong>
            </label>
            <input
              id="order-count"
              type="range"
              min="1"
              max={state.provider === "stripe" ? 1 : 20}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
            <div className="range-labels">
              <span>1 order</span>
              <span>{state.provider === "stripe" ? 1 : 20} orders</span>
            </div>
            <label className="field-label" htmlFor="fault">
              Failure scenario
            </label>
            <select
              id="fault"
              className="fault-select"
              disabled={!state.faultInjection}
              value={fault}
              onChange={(e) => setFault(e.target.value as Fault)}
            >
              <option value="none">Happy path · all services healthy</option>
              <option value="payment">
                Payment declined · compensate inventory
              </option>
              <option value="fulfillment">
                Fulfillment unavailable · route to DLQ
              </option>
            </select>
            <div className="simulation-note">
              <ShieldCheck size={18} />
              <p>
                {fault === "none"
                  ? "Each order reserves inventory, processes a payment, and completes fulfillment."
                  : fault === "payment"
                    ? "One in three payments will decline. Reserved stock is released automatically."
                    : "One in three deliveries will fail. Retry them from the dead-letter queue without charging twice."}
              </p>
            </div>
            <button
              className="button primary full run-button"
              disabled={busy || !state.stock.length}
              onClick={() => void run()}
            >
              <Zap size={16} />
              {busy
                ? "Creating…"
                : `Create ${state.provider === "stripe" ? 1 : count} order(s)`}
              <ArrowRight size={16} />
            </button>
            <p className="modal-foot">
              {state.provider === "mock"
                ? "Payments use the local provider. Database and Kafka operations are real."
                : "Stripe payments require confirmation in the order inspector."}{" "}
              {!state.faultInjection && "Fault injection is disabled."}
            </p>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={17} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
function Metric({
  title,
  value,
  suffix,
  icon,
  trend,
  note,
  data,
  amber = false,
}: {
  title: string;
  value: string;
  suffix?: string;
  icon: ReactNode;
  trend: string;
  note: string;
  data: number[];
  amber?: boolean;
}) {
  return (
    <section className={"metric panel " + (amber ? "amber" : "")}>
      <div className="metric-top">
        <span>{title}</span>
        {icon}
      </div>
      <div className="metric-value">
        {value}
        <span>{suffix}</span>
      </div>
      <div className="metric-bottom">
        <div>
          <span className="metric-trend">
            {amber ? (
              <span className="amber-dot" />
            ) : (
              <ArrowUpRight size={12} />
            )}{" "}
            {trend}
          </span>
          <small>{note}</small>
        </div>
        <svg viewBox="0 0 90 40" aria-hidden="true">
          <polyline
            points={data
              .map((v, i) => `${(i * 90) / (data.length - 1)},${40 - v}`)
              .join(" ")}
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          />
        </svg>
      </div>
    </section>
  );
}
