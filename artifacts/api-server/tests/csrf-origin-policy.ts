import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { csrfProtection } from "../src/middleware/csrf";

type RequestOverrides = {
  path?: string;
  headers?: Record<string, string>;
};

function checkRequest(overrides: RequestOverrides = {}) {
  let nextCalled = false;
  let statusCode = 200;
  let body: unknown;
  const req = {
    method: "POST",
    path: overrides.path ?? "/api/sites",
    protocol: "https",
    headers: {
      host: "app.example.test",
      origin: "https://app.example.test",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": "session-token",
      ...overrides.headers,
    },
    session: { userId: 17, csrfToken: "session-token" },
  } as unknown as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;
  csrfProtection(req, res, (() => { nextCalled = true; }) as NextFunction);
  return { nextCalled, statusCode, body };
}

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
try {
  assert.equal(checkRequest().nextCalled, true, "valid same-origin cookie request passes");
  assert.equal(checkRequest({ headers: { origin: "https://app.example.test:444" } }).statusCode, 403,
    "a different port is a different origin");
  assert.equal(checkRequest({ headers: { origin: "https://attacker.example" } }).statusCode, 403,
    "a foreign origin is rejected even with a valid CSRF token");
  assert.equal(checkRequest({ headers: { "sec-fetch-site": "cross-site" } }).statusCode, 403,
    "cross-site Fetch Metadata is rejected");
  assert.equal(checkRequest({
    headers: { origin: "", "sec-fetch-site": "same-origin" },
  }).nextCalled, true, "same-origin Fetch Metadata is accepted when Origin is omitted");
  assert.equal(checkRequest({
    headers: { origin: "", "sec-fetch-site": "" },
  }).statusCode, 403, "missing Origin and Fetch Metadata are rejected");
  assert.equal(checkRequest({
    headers: { "x-csrf-token": "wrong" },
  }).statusCode, 403, "a mismatched session token is rejected");
  assert.equal(checkRequest({
    path: "/api/sign-off/high-entropy-token/acknowledge",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site", "x-csrf-token": "" },
  }).nextCalled, true, "public sign-off capability routes remain usable with unrelated session cookies");
  assert.equal(checkRequest({
    headers: { authorization: "Bearer mobile-session", origin: "https://attacker.example" },
  }).nextCalled, true, "bearer-authenticated mobile requests are exempt");
} finally {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
}

console.log("CSRF exact-origin policy checks passed");