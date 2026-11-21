import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;

import worker, {
  PLAN_CONFIG,
  signToken,
  verifyToken,
  renderTemplate,
  computeLocalFitScore,
} from "../worker/src/index.js";

// 1. Test Plan Configs (INR)
assert.equal(PLAN_CONFIG.free.max_loops, 2);
assert.equal(PLAN_CONFIG.pro.price_inr, 499);
assert.equal(PLAN_CONFIG.max.max_loops, 50);
assert.equal(PLAN_CONFIG.max.price_inr, 999);

// 2. Test HMAC-SHA256 Token Sign & Verify (1-click UPI approval)
const secret = "test-super-secret-key-123";
const token = await signToken(
  { req_id: "req_1", email: "user@example.in", plan: "max", exp: Date.now() + 60000 },
  secret
);
const verified = await verifyToken(token, secret);
assert.equal(verified.email, "user@example.in");
assert.equal(verified.plan, "max");

// Tampered token must fail
const tampered = token.slice(0, -3) + "xxx";
assert.equal(await verifyToken(tampered, secret), null);

// Expired token must fail
const expired = await signToken({ req_id: "req_2", exp: Date.now() - 1000 }, secret);
assert.equal(await verifyToken(expired, secret), null);

// 3. Test Template Email Variable Rendering
const rendered = renderTemplate(
  "Hi {{company}} team, applying for {{role}} — {{name}} ({{skills}})",
  { company: "Razorpay", role: "Backend Engineer", name: "Aarav", skills: "Python, Go" }
);
assert.equal(rendered, "Hi Razorpay team, applying for Backend Engineer — Aarav (Python, Go)");

// 4. Test Local Fit Scoring
const scoreHigh = computeLocalFitScore(
  "Senior Python FastAPI PostgreSQL AWS Docker Kubernetes Bengaluru",
  "Python Backend Engineer",
  "Looking for Python FastAPI PostgreSQL AWS developer"
);
const scoreLow = computeLocalFitScore(
  "Graphic designer Photoshop Illustrator",
  "Rust Systems Engineer",
  "Kernel systems programming in Rust and C++"
);
assert.ok(scoreHigh > scoreLow, `Expected ${scoreHigh} > ${scoreLow}`);

// 5. Test Worker HTTP Handler (Health + UPI Validation + Mocked Supabase/Resend)
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("profiles?email=eq.")) {
    return new Response(JSON.stringify([{ id: "user-uuid-1", email: "test@india.in" }]), { status: 200 });
  }
  if (u.includes("upi_payment_requests") && opts?.method === "POST") {
    return new Response(JSON.stringify([{ id: "upi-req-99" }]), { status: 201 });
  }
  if (u.includes("api.resend.com/emails")) {
    return new Response(JSON.stringify({ id: "email-123" }), { status: 200 });
  }
  return new Response(JSON.stringify([]), { status: 200 });
};

const env = {
  SUPABASE_URL: "https://mock.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "mock-key",
  RESEND_API_KEY: "mock-resend",
  OWNER_EMAIL: "owner@jobby.in",
  HMAC_SECRET: secret,
};

const healthRes = await worker.fetch(new Request("https://jobby.workers.dev/api/health"), env);
assert.equal(healthRes.status, 200);
assert.deepEqual(await healthRes.json(), { ok: true, service: "jobby-api" });

// Invalid UTR should return 400
const badUpiRes = await worker.fetch(
  new Request("https://jobby.workers.dev/api/upi-request", {
    method: "POST",
    body: JSON.stringify({ email: "test@india.in", requested_plan: "max", utr_number: "123" }),
  }),
  env
);
assert.equal(badUpiRes.status, 400);

// Valid UPI request should return 200
const goodUpiRes = await worker.fetch(
  new Request("https://jobby.workers.dev/api/upi-request", {
    method: "POST",
    body: JSON.stringify({ email: "test@india.in", requested_plan: "max", utr_number: "432198765432" }),
  }),
  env
);
assert.equal(goodUpiRes.status, 200);
const goodData = await goodUpiRes.json();
assert.equal(goodData.ok, true);
assert.equal(goodData.request_id, "upi-req-99");

globalThis.fetch = originalFetch;
console.log("WORKER TESTS PASSED (ALL ASSERTIONS)");
