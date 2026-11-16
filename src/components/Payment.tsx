"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { api } from "./control-plane";
export function Payment({
  orderId,
  publishableKey,
  onComplete,
}: {
  orderId: string;
  publishableKey: string;
  onComplete: () => void;
}) {
  const [secret, setSecret] = useState(""),
    [error, setError] = useState("");
  const stripe = useMemo(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    [publishableKey],
  );
  useEffect(() => {
    let active = true;
    api(`orders/${orderId}/payment`)
      .then((data) => {
        if (active) setSecret(data.clientSecret || "");
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [orderId]);
  if (!publishableKey)
    return <p role="alert">Stripe publishable key is not configured.</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!secret) return <p>Loading secure payment form…</p>;
  return (
    <Elements
      stripe={stripe}
      options={{ clientSecret: secret, appearance: { theme: "night" } }}
    >
      <Checkout onComplete={onComplete} />
    </Elements>
  );
}
function Checkout({ onComplete }: { onComplete: () => void }) {
  const stripe = useStripe(),
    elements = useElements();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError("");
    try {
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: window.location.origin },
        redirect: "if_required",
      });
      if (result.error)
        setError(result.error.message || "Payment could not be completed");
      else onComplete();
    } catch {
      setError(
        "Payment confirmation failed. Check the order before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <PaymentElement />
      <button
        className="button primary full"
        style={{ marginTop: 16 }}
        disabled={!stripe || busy}
      >
        {busy ? "Confirming…" : "Pay securely"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
