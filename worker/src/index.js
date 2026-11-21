/**
 * Jobby API — Cloudflare Worker (Free Tier)
 * Handles:
 *  - POST /api/upi-request       (logs UPI UTR & emails Owner a 1-click HMAC approval link)
 *  - GET  /api/admin/approve-upi (verifies HMAC token, upgrades user plan in Supabase)
 *  - POST /api/send-template-email (renders {{variables}} and sends via Resend)
 *  - POST /api/ai-match          (scores CV vs Job using Gemini 2.5 Flash-Lite or local fallback)
 *  - scheduled()                 (daily Supabase keepalive ping)
 */

export const PLAN_CONFIG = {
  free: { max_loops: 2, daily_apply_limit: 15, price_inr: 0 },
  pro: { max_loops: 25, daily_apply_limit: 75, price_inr: 499 },
  max: { max_loops: 50, daily_apply_limit: 150, price_inr: 999 },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function signToken(payloadObj, secret) {
  const payload = btoa(JSON.stringify(payloadObj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${payload}.${sig}`;
}

export async function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sigBin = Uint8Array.from(
    atob(sig.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBin,
    new TextEncoder().encode(payload)
  );
  if (!valid) return null;
  const decoded = JSON.parse(
    atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
  );
  if (decoded.exp && Date.now() > decoded.exp) return null;
  return decoded;
}

export function renderTemplate(templateStr, vars) {
  return String(templateStr || "").replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_, key) => (vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : "")
  );
}

async function supabaseFetch(env, path, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendResendEmail(env, { to, subject, htmlBody, replyTo }) {
  if (!env.RESEND_API_KEY) {
    return { mocked: true, to, subject };
  }
  const payload = {
    from: env.FROM_EMAIL || "Jobby <onboarding@resend.dev>",
    to: Array.isArray(to) ? to : [to],
    subject,
    html: htmlBody,
  };
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Resend error ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export function computeLocalFitScore(cvText, jobTitle, jobDesc) {
  const cvTokens = new Set(
    String(cvText || "")
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((w) => w.length > 2)
  );
  if (cvTokens.size === 0) return 65;
  const jobTokens = `${jobTitle || ""} ${jobDesc || ""}`
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 2);
  if (jobTokens.length === 0) return 65;
  const uniqueJob = new Set(jobTokens);
  let hits = 0;
  for (const tok of uniqueJob) {
    if (cvTokens.has(tok)) hits++;
  }
  const ratio = hits / Math.min(uniqueJob.size, 35);
  return Math.max(35, Math.min(98, Math.round(40 + ratio * 60)));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      // Health check
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "jobby-api" });
      }

      // 1. Submit UPI Payment Confirmation -> Email Owner
      if (url.pathname === "/api/upi-request" && request.method === "POST") {
        const body = await request.json();
        const email = String(body.email || "").trim().toLowerCase();
        const plan = String(body.requested_plan || "").trim().toLowerCase();
        const utr = String(body.utr_number || "").trim();

        if (!email || !email.includes("@")) {
          return json({ error: "Valid account email is required." }, 400);
        }
        if (!PLAN_CONFIG[plan] || plan === "free") {
          return json({ error: "Requested plan must be 'pro' or 'max'." }, 400);
        }
        if (!/^[a-zA-Z0-9]{8,22}$/.test(utr)) {
          return json({ error: "Valid 8-22 character UPI UTR reference is required." }, 400);
        }

        const amount_inr = PLAN_CONFIG[plan].price_inr;

        // Look up user profile if exists
        const profiles = await supabaseFetch(
          env,
          `profiles?email=eq.${encodeURIComponent(email)}&select=id,email`
        );
        const userId = profiles.length > 0 ? profiles[0].id : null;

        const inserted = await supabaseFetch(env, "upi_payment_requests", {
          method: "POST",
          body: JSON.stringify({
            user_id: userId,
            email,
            requested_plan: plan,
            amount_inr,
            utr_number: utr,
            status: "pending",
          }),
        });

        const reqRow = inserted[0];
        const token = await signToken(
          {
            req_id: reqRow.id,
            email,
            plan,
            exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
          },
          env.HMAC_SECRET
        );
        const approveUrl = `${url.origin}/api/admin/approve-upi?token=${encodeURIComponent(token)}`;

        await sendResendEmail(env, {
          to: env.OWNER_EMAIL,
          subject: `[Jobby UPI] ₹${amount_inr} (${plan.toUpperCase()}) from ${email}`,
          htmlBody: `
            <h2>New Jobby UPI Payment Verification</h2>
            <p><strong>Account Email:</strong> ${email}</p>
            <p><strong>Plan Requested:</strong> ${plan.toUpperCase()} (₹${amount_inr})</p>
            <p><strong>UPI UTR Reference:</strong> <code>${utr}</code></p>
            <p>Verify this UTR in your UPI app, then click below to activate immediately:</p>
            <p><a href="${approveUrl}" style="display:inline-block;padding:12px 20px;background:#0F62FE;color:#fff;text-decoration:none;font-weight:bold;">Approve &amp; Grant ${plan.toUpperCase()}</a></p>
          `,
        });

        return json({
          ok: true,
          message: "Payment details submitted. Owner has been notified for activation.",
          request_id: reqRow.id,
        });
      }

      // 2. Owner 1-Click Approval via Signed HMAC Link
      if (url.pathname === "/api/admin/approve-upi" && request.method === "GET") {
        const token = url.searchParams.get("token");
        const data = await verifyToken(token, env.HMAC_SECRET);
        if (!data) {
          return html("<h1>Invalid or expired approval link.</h1>", 403);
        }

        const cfg = PLAN_CONFIG[data.plan];
        if (!cfg) return html("<h1>Unknown plan.</h1>", 400);

        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        await supabaseFetch(
          env,
          `profiles?email=eq.${encodeURIComponent(data.email)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              plan_tier: data.plan,
              max_loops: cfg.max_loops,
              daily_apply_limit: cfg.daily_apply_limit,
              plan_expires_at: expiresAt,
              is_active: true,
            }),
          }
        );

        await supabaseFetch(
          env,
          `upi_payment_requests?id=eq.${encodeURIComponent(data.req_id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ status: "approved" }),
          }
        );

        await sendResendEmail(env, {
          to: data.email,
          subject: `Your Jobby ${data.plan.toUpperCase()} plan is active!`,
          htmlBody: `
            <h2>Welcome to Jobby ${data.plan.toUpperCase()}</h2>
            <p>Your UPI payment has been verified. Your account now supports up to <strong>${cfg.max_loops} parallel loops</strong> and <strong>${cfg.daily_apply_limit} daily applications</strong> for the next 30 days.</p>
          `,
        });

        return html(`
          <html><body style="font-family:sans-serif;padding:40px;">
            <h2>Approved: ${data.email}</h2>
            <p>Upgraded to <strong>${data.plan.toUpperCase()}</strong> (${cfg.max_loops} loops, ${cfg.daily_apply_limit} applies/day) until ${expiresAt}.</p>
          </body></html>
        `);
      }

      // 3. Send Template Email (No tracking pixels, pure outreach)
      if (url.pathname === "/api/send-template-email" && request.method === "POST") {
        const body = await request.json();
        const { user_id, to_email, reply_to, subject_template, body_template, variables, match_id } = body;
        if (!user_id || !to_email || !subject_template || !body_template) {
          return json({ error: "Missing required email fields." }, 400);
        }

        const profiles = await supabaseFetch(
          env,
          `profiles?id=eq.${encodeURIComponent(user_id)}&select=is_active,email`
        );
        if (profiles.length === 0 || !profiles[0].is_active) {
          return json({ error: "Account is inactive or suspended by owner." }, 403);
        }

        const subject = renderTemplate(subject_template, variables || {});
        const renderedBody = renderTemplate(body_template, variables || {});
        const htmlBody = renderedBody
          .split("\n")
          .map((line) => `<p>${line.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
          .join("");

        const result = await sendResendEmail(env, {
          to: to_email,
          subject,
          htmlBody,
          replyTo: reply_to || profiles[0].email,
        });

        if (match_id) {
          await supabaseFetch(
            env,
            `job_matches?id=eq.${encodeURIComponent(match_id)}`,
            {
              method: "PATCH",
              body: JSON.stringify({ dispatched: true }),
            }
          );
        }

        return json({ ok: true, result });
      }

      // 4. AI Fit Scoring & Screening Answer Prep (Gemini 2.5 Flash-Lite)
      if (url.pathname === "/api/ai-match" && request.method === "POST") {
        const body = await request.json();
        const { cv_text, job_title, job_description, candidate_profile } = body;

        if (!env.GEMINI_API_KEY) {
          return json({
            fit_score: computeLocalFitScore(cv_text, job_title, job_description),
            ai_answers: {
              notice_period: `${candidate_profile?.notice_period_days ?? 30} days`,
              expected_ctc: candidate_profile?.expected_ctc_lpa || "As per company standards",
              why_fit: `Strong alignment with ${job_title} requirements based on candidate background.`,
            },
            provider: "local-fallback",
          });
        }

        const prompt = `Evaluate candidate fit for "${job_title}". Return strict JSON with keys: fit_score (integer 0-100), notice_period (string), expected_ctc (string), why_fit (2-sentence answer).
Candidate Profile: ${JSON.stringify(candidate_profile || {})}
CV Excerpt: ${String(cv_text || "").slice(0, 2500)}
Job Description: ${String(job_description || "").slice(0, 2500)}`;

        const gemRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json" },
            }),
          }
        );
        const gemData = await gemRes.json();
        const rawText = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        const parsed = JSON.parse(rawText);
        return json({
          fit_score: parsed.fit_score ?? 75,
          ai_answers: {
            notice_period: parsed.notice_period || "",
            expected_ctc: parsed.expected_ctc || "",
            why_fit: parsed.why_fit || "",
          },
          provider: "gemini-2.5-flash-lite",
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Keep Supabase Free project awake (prevents 7-day inactivity pause)
    ctx.waitUntil(
      supabaseFetch(env, "profiles?select=id&limit=1").catch((e) =>
        console.error("Keepalive failed:", e)
      )
    );
  },
};
