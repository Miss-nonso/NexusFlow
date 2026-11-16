import pino from "pino";
import {
  context,
  propagation,
  trace,
  SpanStatusCode,
} from "@opentelemetry/api";
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: process.env.SERVICE_ROLE || "web" },
  redact: ["password", "authorization", "client_secret", "token"],
});
export async function traced<T>(
  name: string,
  parent: string | undefined,
  fn: () => Promise<T>,
) {
  const ctx = parent
    ? propagation.extract(context.active(), { traceparent: parent })
    : context.active();
  return trace
    .getTracer("nexusflow")
    .startActiveSpan(name, {}, ctx, async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
export function currentTrace(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}
