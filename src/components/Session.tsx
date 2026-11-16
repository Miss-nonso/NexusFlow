"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Layers, ShieldCheck } from "lucide-react";
import { api } from "./control-plane";
import Dashboard from "./Dashboard";
export default function Session() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("auth/session")
      .then((r) => setAuth(r.authenticated))
      .catch(() => {
        setAuth(false);
        setError("Unable to connect to the server");
      });
  }, []);
  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      setError("");
      setAuth(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (auth === null)
    return (
      <div className="login-shell">
        <p>Connecting to NexusFlow…</p>
      </div>
    );
  if (auth)
    return (
      <Dashboard
        onLogout={async () => {
          await api("auth/logout", { method: "POST" });
          setAuth(false);
        }}
      />
    );
  return (
    <div className="login-shell">
      <form className="modal login-card" onSubmit={login}>
        <div className="brand">
          <Layers color="#b9ec8d" />
          NexusFlow
        </div>
        <span className="eyebrow">OPERATIONS CONTROL PLANE</span>
        <h1>Welcome back.</h1>
        <p>Sign in to manage orders, inventory, and payments.</p>
        <label className="field-label" htmlFor="password">
          Admin password
        </label>
        <input
          autoFocus
          id="password"
          type="password"
          autoComplete="current-password"
          required
          className="fault-select"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary full"
          style={{ marginTop: 24 }}
          disabled={busy}
        >
          {busy ? "Signing in…" : "Sign in"}
          <ShieldCheck size={15} />
        </button>
        <p className="modal-foot">
          Use ADMIN_PASSWORD from your deployment environment.
        </p>
      </form>
    </div>
  );
}
