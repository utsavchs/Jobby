import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.JOBBY_CONFIG;
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const PLAN_LIMITS = {
  free: { max_loops: 2, daily_apply_limit: 15 },
  pro: { max_loops: 25, daily_apply_limit: 75 },
  max: { max_loops: 50, daily_apply_limit: 150 },
};

let allProfiles = [];

async function init() {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) {
    document.getElementById("admin-gate").textContent = "Please sign in on the main page first.";
    return;
  }
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "owner") {
    document.getElementById("admin-gate").textContent = "Access denied: Owner role required.";
    return;
  }
  document.getElementById("admin-gate").classList.add("hidden");
  document.getElementById("admin-main").classList.remove("hidden");
  await Promise.all([loadUpiRequests(), loadAccounts()]);
}

async function loadUpiRequests() {
  const { data } = await supabase
    .from("upi_payment_requests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  document.getElementById("upi-requests-table").innerHTML = `
    <table>
      <thead><tr><th>Email</th><th>Plan</th><th>Amount</th><th>UTR</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>
        ${(data || [])
          .map(
            (r) => `
          <tr>
            <td>${r.email}</td>
            <td>${r.requested_plan.toUpperCase()}</td>
            <td>₹${r.amount_inr}</td>
            <td><code>${r.utr_number}</code></td>
            <td><span class="badge ${r.status === "approved" ? "badge-ok" : "badge-warn"}">${r.status}</span></td>
            <td>
              ${
                r.status === "pending"
                  ? `<button class="btn btn-sm btn-primary" onclick="window.approveUpi('${r.id}', '${r.email}', '${r.requested_plan}')">Approve &amp; Grant</button>`
                  : "—"
              }
            </td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

window.approveUpi = async (reqId, email, plan) => {
  const limits = PLAN_LIMITS[plan];
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await supabase
    .from("profiles")
    .update({
      plan_tier: plan,
      max_loops: limits.max_loops,
      daily_apply_limit: limits.daily_apply_limit,
      plan_expires_at: expiresAt,
      is_active: true,
    })
    .eq("email", email);
  await supabase.from("upi_payment_requests").update({ status: "approved" }).eq("id", reqId);
  await Promise.all([loadUpiRequests(), loadAccounts()]);
};

async function loadAccounts() {
  const { data } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  allProfiles = data || [];
  renderAccounts(allProfiles);
}

function renderAccounts(rows) {
  document.getElementById("accounts-table").innerHTML = `
    <table>
      <thead><tr><th>Email</th><th>Plan</th><th>Loops</th><th>Status</th><th>Controls</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (p) => `
          <tr>
            <td>${p.email}</td>
            <td>${p.plan_tier.toUpperCase()}</td>
            <td>${p.max_loops}</td>
            <td><span class="badge ${p.is_active ? "badge-ok" : "badge-danger"}">${p.is_active ? "Active" : "Suspended"}</span></td>
            <td style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="btn btn-sm" onclick="window.setPlan('${p.id}', 'free')">Free</button>
              <button class="btn btn-sm" onclick="window.setPlan('${p.id}', 'pro')">Pro</button>
              <button class="btn btn-sm btn-primary" onclick="window.setPlan('${p.id}', 'max')">Max</button>
              <button class="btn btn-sm btn-danger" onclick="window.toggleActive('${p.id}', ${!p.is_active})">${p.is_active ? "Suspend" : "Activate"}</button>
            </td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

window.setPlan = async (id, plan) => {
  const limits = PLAN_LIMITS[plan];
  await supabase
    .from("profiles")
    .update({ plan_tier: plan, max_loops: limits.max_loops, daily_apply_limit: limits.daily_apply_limit })
    .eq("id", id);
  await loadAccounts();
};

window.toggleActive = async (id, nextState) => {
  await supabase.from("profiles").update({ is_active: nextState }).eq("id", id);
  await loadAccounts();
};

document.getElementById("search-email").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  renderAccounts(allProfiles.filter((p) => p.email.toLowerCase().includes(q)));
});

init();
