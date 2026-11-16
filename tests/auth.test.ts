import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authenticated,
  signSession,
  verifySession,
  requireAuth,
  readBody,
  HttpError,
} from "../src/backend/auth";
process.env.SESSION_SECRET = "session-secret-for-unit-tests-only-000000";
process.env.ADMIN_API_TOKEN = "api-token-for-unit-tests-only-000000000";
process.env.APP_ORIGIN = "http://localhost:8080";
test("signed sessions reject tampering and expiry", () => {
  const valid = signSession();
  assert.equal(verifySession(valid), true);
  assert.equal(verifySession(valid + "x"), false);
  assert.equal(verifySession(signSession(Date.now() - 1)), false);
});
test("mutations authenticated by cookie enforce Origin", () => {
  const headers = { cookie: `nf_session=${signSession()}` };
  assert.throws(
    () =>
      requireAuth(
        new Request("http://localhost/api/orders", { method: "POST", headers }),
      ),
    HttpError,
  );
  assert.doesNotThrow(() =>
    requireAuth(
      new Request("http://localhost/api/orders", {
        method: "POST",
        headers: { ...headers, origin: process.env.APP_ORIGIN! },
      }),
    ),
  );
  assert.doesNotThrow(() =>
    requireAuth(
      new Request("http://127.0.0.1:3000/api/orders", {
        method: "POST",
        headers: { ...headers, origin: "http://127.0.0.1:3000" },
      }),
    ),
  );
  assert.doesNotThrow(() =>
    requireAuth(
      new Request("http://nexusflow-web:3000/api/orders", {
        method: "POST",
        headers: {
          ...headers,
          host: "nexusflow-web:3000",
          "x-forwarded-host": "orders.example.test",
          "x-forwarded-proto": "https",
          origin: "https://orders.example.test",
        },
      }),
    ),
  );
});
test("cookie mutations still reject cross-site origins", () => {
  assert.throws(
    () =>
      requireAuth(
        new Request("http://localhost:8080/api/orders", {
          method: "POST",
          headers: {
            cookie: `nf_session=${signSession()}`,
            origin: "https://attacker.example",
            host: "localhost:8080",
          },
        }),
      ),
    HttpError,
  );
});
test("invalid bearer cannot fall back to a cookie or bypass CSRF", () => {
  const request = new Request("http://localhost/api/orders", {
    method: "POST",
    headers: {
      cookie: `nf_session=${signSession()}`,
      authorization: "Bearer invalid",
    },
  });
  assert.equal(authenticated(request), false);
  assert.throws(() => requireAuth(request), HttpError);
});
test("valid API token does not require a browser origin", () => {
  const request = new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}` },
  });
  assert.doesNotThrow(() => requireAuth(request));
});
test("streaming body limit does not trust content-length", async () => {
  await assert.rejects(
    readBody(
      new Request("http://localhost", { method: "POST", body: "123456789" }),
      5,
    ),
    HttpError,
  );
});
