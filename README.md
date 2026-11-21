# Jobby — Zero-Cost LoopCV Replica for India

Jobby is a multi-loop job application and template email outreach platform built for Indian job portals and company career pages, hosted entirely on free-tier infrastructure.

## Folder Structure
- `supabase/schema.sql` — Postgres tables (`profiles`, `loops`, `email_templates`, `job_matches` dedup-only, `upi_payment_requests`) + RLS + Owner helper.
- `worker/` — Cloudflare Worker API (`/api/upi-request`, `/api/admin/approve-upi`, `/api/send-template-email`, `/api/ai-match`, daily keepalive cron).
- `scraper/` — Python loop scraper (`JobSpy` for Naukri/LinkedIn/Indeed/Glassdoor + Greenhouse/Lever/Ashby public JSON APIs) run by `.github/workflows/jobby-loops.yml`.
- `web/` — Static web app (`index.html`, `admin.html`) ready for Cloudflare Pages.
- `extension/` — Manifest V3 Chrome extension for Indian portals, company portal auto-signup, and human-in-the-loop help on OTPs/CAPTCHAs.
- `tests/` — Automated unit & integration tests.

## Free-Tier Deployment Steps
1. **Supabase (₹0):** Create a free project, run `supabase/schema.sql` in SQL Editor, and set your own user row to `role = 'owner'` (`update public.profiles set role = 'owner' where email = 'you@example.com';`).
2. **Cloudflare Worker (₹0):** In `worker/`, run `npx wrangler deploy` and set secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `OWNER_EMAIL`, `HMAC_SECRET`, optional `GEMINI_API_KEY`).
3. **Cloudflare Pages (₹0):** Update `web/config.js` with your Supabase URL/Anon Key, Worker URL, and UPI ID, then deploy `web/` directly to Cloudflare Pages.
4. **GitHub Actions (₹0):** Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to GitHub Repository Secrets so `.github/workflows/jobby-loops.yml` runs every 4 hours.
5. **Chrome Extension (₹0):** Open `chrome://extensions`, enable Developer Mode, and click **Load unpacked** on `extension/`.
