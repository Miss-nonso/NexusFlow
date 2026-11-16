import { z } from "zod";
import {
  authenticated,
  constantEqual,
  cookie,
  HttpError,
  isAllowedOrigin,
  jsonBody,
  readBody,
  requireAuth,
  signSession,
} from "./auth";
import { required } from "./config";
import { redis, limit } from "./redis";
import { database } from "./db";
import {
  createOrder,
  getOrder,
  retryOrder,
  refundOrder,
  snapshot,
} from "./orders";
import { internal } from "./internal";
import { logger, traced } from "./telemetry";
const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};
const json = (
  data: unknown,
  status = 200,
  extra: Record<string, string> = {},
) => Response.json(data, { status, headers: { ...headers, ...extra } });
export async function handle(request: Request) {
  const path = new URL(request.url).pathname.replace(/^\/api\/?/, "");
  return traced(
    `http.${request.method}.${path.replace(/[0-9a-f-]{36}/g, ":id")}`,
    request.headers.get("traceparent") || undefined,
    async () => {
      try {
        if (path === "health") {
          const [postgres, cache] = await Promise.allSettled([
            database().query("SELECT 1"),
            redis().ping(),
          ]);
          const dependencies = {
            postgres: postgres.status === "fulfilled",
            redis: cache.status === "fulfilled" && cache.value === "PONG",
          };
          const healthy = Object.values(dependencies).every(Boolean);
          return json(
            { status: healthy ? "ok" : "unavailable", dependencies },
            healthy ? 200 : 503,
          );
        }
        if (path === "auth/session" && request.method === "GET")
          return json({ authenticated: authenticated(request) });
        if (path === "auth/login" && request.method === "POST") {
          if (!isAllowedOrigin(request))
            throw new HttpError(403, "Request origin is not allowed");
          // A global bound also prevents spoofed forwarded addresses from bypassing the limit.
          let withinLoginLimit: boolean;
          try {
            withinLoginLimit = await limit("login", 10, 60);
          } catch (error) {
            logger.error(
              {
                errorType: error instanceof Error ? error.name : "Error",
                errorCode:
                  typeof error === "object" && error && "code" in error
                    ? String(error.code)
                    : undefined,
                errorMessage:
                  error instanceof Error
                    ? error.message
                        .replace(/redis:\/\/[^\s@]+@/gi, "redis://[redacted]@")
                        .replace(/(password|pass)=\S+/gi, "$1=[redacted]")
                        .slice(0, 180)
                    : undefined,
                redisConnectionConfigured: Boolean(
                  process.env.REDIS_URL || process.env.REDIS_PASSWORD,
                ),
                path,
              },
              "Login rate limiter unavailable",
            );
            return json(
              { error: "Sign-in is temporarily unavailable: rate limiter service failed" },
              503,
            );
          }
          if (!withinLoginLimit)
            throw new HttpError(
              429,
              "Too many sign-in attempts. Try again shortly.",
            );
          const body = z
            .object({ password: z.string().max(1024) })
            .parse(await jsonBody(request));
          if (!constantEqual(body.password, required("ADMIN_PASSWORD")))
            throw new HttpError(401, "Invalid password");
          return json({ ok: true }, 200, {
            "Set-Cookie": cookie(signSession()),
          });
        }
        if (path === "stripe/webhook" && request.method === "POST") {
          const response = await fetch(
            `${required("PAYMENT_SERVICE_URL")}/stripe/webhook`,
            {
              method: "POST",
              headers: {
                "x-internal-token": required("INTERNAL_TOKEN"),
                "stripe-signature":
                  request.headers.get("stripe-signature") || "",
                "content-type": "application/json",
              },
              body: new Uint8Array(await readBody(request, 262144)),
              signal: AbortSignal.timeout(25000),
            },
          );
          return json({ received: response.ok }, response.status);
        }
        requireAuth(request);
        if (!(await limit("admin-api", 600, 60)))
          throw new HttpError(429, "Request rate exceeded");
        if (path === "auth/logout" && request.method === "POST")
          return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
        if (path === "state" && request.method === "GET") {
          const hours = Number(
            new URL(request.url).searchParams.get("hours") || 1,
          );
          if (![1, 6, 24].includes(hours))
            throw new HttpError(400, "Unsupported time range");
          return json(await snapshot(hours));
        }
        if (path === "orders" && request.method === "POST") {
          const result = await createOrder(
            await jsonBody(request),
            request.headers.get("idempotency-key") || "",
          );
          return json(result, result.replayed ? 200 : 202, {
            Location: `/api/orders/${result.id}`,
          });
        }
        const match = path.match(
          /^orders\/([0-9a-f-]{36})(?:\/(retry|refund|payment))?$/i,
        );
        if (match) {
          const [, id, action] = match;
          if (!action && request.method === "GET")
            return json(await getOrder(id));
          if (action === "retry" && request.method === "POST")
            return json(await retryOrder(id), 202);
          if (action === "refund" && request.method === "POST")
            return json(await refundOrder(id), 202);
          if (action === "payment" && request.method === "GET") {
            await getOrder(id);
            return json(await internal("payment", `/payments/${id}`));
          }
        }
        if (path === "events" && request.method === "GET") {
          const encoder = new TextEncoder();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let closed = false;
          const stream = new ReadableStream({
            start(controller) {
              const close = () => {
                if (closed) return;
                closed = true;
                clearTimeout(timer);
                try {
                  controller.close();
                } catch {}
              };
              request.signal.addEventListener("abort", close, { once: true });
              const send = async () => {
                if (closed) return;
                if (!authenticated(request)) {
                  close();
                  return;
                }
                try {
                  const time = (
                    await database().query(
                      "SELECT max(updated_at) AS time FROM orders",
                    )
                  ).rows[0].time;
                  controller.enqueue(
                    encoder.encode(
                      `event: change\ndata: ${JSON.stringify({ time })}\n\n`,
                    ),
                  );
                } catch {
                  close();
                  return;
                }
                if (!closed) timer = setTimeout(send, 2000);
              };
              void send();
            },
            cancel() {
              closed = true;
              clearTimeout(timer);
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        }
        throw new HttpError(404, "Endpoint not found");
      } catch (error) {
        if (error instanceof HttpError)
          return json(
            { error: error.message },
            error.status,
            error.status === 429 ? { "Retry-After": "60" } : {},
          );
        if (error instanceof z.ZodError)
          return json(
            {
              error: "Invalid request",
              details: error.issues.map((i) => ({
                path: i.path,
                message: i.message,
              })),
            },
            400,
          );
        logger.error(
          { errorType: error instanceof Error ? error.name : "Error", path },
          "API request failed",
        );
        return json({ error: "Service temporarily unavailable" }, 503);
      }
    },
  );
}
