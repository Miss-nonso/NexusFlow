import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { required } from "./config";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function constantEqual(a: string, b: string) {
  const aa = createHash("sha256").update(a).digest(),
    bb = createHash("sha256").update(b).digest();
  return timingSafeEqual(aa, bb);
}
export function signSession(expires = Date.now() + 8 * 3600000) {
  const payload = Buffer.from(
    JSON.stringify({ sub: "admin", exp: expires }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", required("SESSION_SECRET")).update(payload).digest("base64url")}`;
}
export function verifySession(token: string) {
  try {
    const [payload, signature, ...extra] = token.split(".");
    if (extra.length || !signature) return false;
    const expected = createHmac("sha256", required("SESSION_SECRET"))
      .update(payload)
      .digest("base64url");
    if (!constantEqual(signature, expected)) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return (
      data.sub === "admin" && Number.isFinite(data.exp) && data.exp > Date.now()
    );
  } catch {
    return false;
  }
}
export function authenticated(request: Request) {
  const header = request.headers.get("authorization");
  if (header)
    return (
      header.startsWith("Bearer ") &&
      constantEqual(header.slice(7), required("ADMIN_API_TOKEN"))
    );
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("nf_session="))
    ?.slice(11);
  return !!cookie && verifySession(cookie);
}
export function isAllowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
    if (!["http:", "https:"].includes(parsedOrigin.protocol)) return false;
    // The Origin header is an origin, never a URL with credentials or a path.
    if (parsedOrigin.origin !== origin) return false;
  } catch {
    return false;
  }

  if (parsedOrigin.origin === new URL(required("APP_ORIGIN")).origin)
    return true;

  // Support local dev ports and reverse proxies whose public host differs from
  // APP_ORIGIN. The browser's Origin must still match the actual request host;
  // the proxy is responsible for overwriting X-Forwarded-Proto.
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    new URL(request.url).host;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto ? `${forwardedProto}:` : new URL(request.url).protocol;
  if (!host || !["http:", "https:"].includes(protocol)) return false;
  return parsedOrigin.origin === `${protocol}//${host}`;
}
export function requireAuth(request: Request) {
  if (!authenticated(request)) throw new HttpError(401, "Sign in to continue");
  if (
    !["GET", "HEAD"].includes(request.method) &&
    !request.headers.get("authorization")?.startsWith("Bearer ")
  ) {
    if (!isAllowedOrigin(request))
      throw new HttpError(403, "Request origin is not allowed");
  }
}
export function cookie(value: string, maxAge = 28800) {
  return `nf_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.SECURE_COOKIES === "true" ? "; Secure" : ""}`;
}
export async function readBody(request: Request, max = 32768) {
  if (Number(request.headers.get("content-length") || 0) > max)
    throw new HttpError(413, "Request body too large");
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new HttpError(413, "Request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function jsonBody(request: Request) {
  try {
    return JSON.parse((await readBody(request)).toString());
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Invalid JSON");
  }
}
