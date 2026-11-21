import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.JOBBY_CONFIG;
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

let currentUser = null;
let currentProfile = null;
let userTemplates = [];

const $ = (id) => document.getElementById(id);

function showMsg(elId, msg, isErr = false) {
  const el = $(elId);
  el.textContent = msg;
  el.style.color = isErr ? "var(--danger)" : "var(--ok)";
}

function renderUpiQr(plan) {
  const amount = plan === "max" ? 999 : 499;
  const upiUri = `upi://pay?pa=${encodeURIComponent(cfg.OWNER_UPI_ID)}&pn=${encodeURIComponent(cfg.OWNER_UPI_NAME)}&am=${amount}&cu=INR&tn=${encodeURIComponent(`Jobby ${plan.toUpperCase()}`)}`;
  $("upi-deep-link").href = upiUri;
  $("upi-link-text").textContent = `UPI ID: ${cfg.OWNER_UPI_ID} · Amount: ₹${amount}`;
  // Lightweight SVG QR placeholder pointing to the UPI URI (replace with static QR image or qr-code-styling in production)
  $("upi-qr-svg").innerHTML = `
    <svg width="160" height="160" viewBox="0 0 160 160" aria-label="UPI QR Code">
      <rect width="160" height="160" fill="#ffffff" stroke="#0f172a" stroke-width="2"/>
      <rect x="14" y="14" width="38" height="38" fill="none" stroke="#0f172a" stroke-width="6"/>
      <rect x="26" y="26" width="14" height="14" fill="#0f172a"/>
      <rect x="108" y="14" width="38" height="38" fill="none" stroke="#0f172a" stroke-width="6"/>
      <rect x="120" y="26" width="14" height="14" fill="#0f172a"/>
      <rect x="14" y="108" width="38" height="38" fill="none" stroke="#0f172a" stroke-width="6"/>
      <rect x="26" y="120" width="14" height="14" fill="#0f172a"/>
      <text x="80" y="84" text-anchor="middle" font-size="12" font-weight="bold" fill="#0f62fe">₹${amount} UPI</text>
      <text x="80" y="100" text-anchor="middle" font-size="10" fill="#475569">${cfg.OWNER_UPI_ID}</text>
    </svg>`;
}

async function loadUserData() {
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  currentProfile = profile;
  if (!profile.is_active) {
    alert("Your Jobby account has been suspended by the owner.");
    await supabase.auth.signOut();
    location.reload();
    return;
  }

  $("user-badge").textContent = `${profile.plan_tier.toUpperCase()} · ${profile.email}`;
  $("user-badge").classList.remove("hidden");
  $("logout-btn").classList.remove("hidden");
  if (profile.role === "owner") $("admin-link").classList.remove("hidden");

  // Populate profile tab
  $("prof-name").value = profile.full_name || "";
  const cp = profile.candidate_profile || {};
  $("prof-phone").value = cp.phone || "";
  $("prof-notice").value = cp.notice_period_days ?? 30;
  $("prof-exp").value = cp.experience_years ?? 0;
  $("prof-cctc").value = cp.current_ctc_lpa || "";
  $("prof-ectc").value = cp.expected_ctc_lpa || "";
  $("prof-skills").value = (cp.skills || []).join(", ");
  $("prof-cv").value = profile.cv_text || "";
  $("upi-email").value = profile.email || "";

  await Promise.all([loadLoops(), loadTemplates(), loadQueue()]);
}

async function loadLoops() {
  const { data: loops } = await supabase
    .from("loops")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });

  $("loop-quota").textContent = `${(loops || []).length} / ${currentProfile.max_loops} loops`;
  $("loops-list").innerHTML = (loops || [])
    .map(
      (l) => `
    <div style="padding:10px 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
      <div>
        <strong>${l.title}</strong> <span class="badge">${l.location}</span>
        <div style="font-size:13px; color:var(--muted);">${l.keywords} · Portals: ${(l.portals || []).join(", ")}</div>
      </div>
      <button class="btn btn-sm btn-danger" onclick="window.deleteLoop('${l.id}')">Delete</button>
    </div>`
    )
    .join("") || "<p style='color:var(--muted);font-size:14px;'>No loops yet.</p>";
}

window.deleteLoop = async (id) => {
  await supabase.from("loops").delete().eq("id", id);
  await loadLoops();
};

async function loadTemplates() {
  const { data: templates } = await supabase
    .from("email_templates")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });
  userTemplates = templates || [];

  $("templates-list").innerHTML = userTemplates
    .map(
      (t) => `
    <div style="padding:10px 0; border-bottom:1px solid var(--border);">
      <strong>${t.name}</strong> — <em>${t.subject}</em>
      <div style="font-size:13px; color:var(--muted); white-space:pre-wrap; margin-top:4px;">${t.body}</div>
    </div>`
    )
    .join("") || "<p style='color:var(--muted);font-size:14px;'>No templates yet.</p>";
}

async function loadQueue() {
  const { data: matches } = await supabase
    .from("job_matches")
    .select("*")
    .eq("user_id", currentUser.id)
    .eq("dispatched", false)
    .order("fit_score", { ascending: false })
    .limit(50);

  $("queue-list").innerHTML = (matches || [])
    .map(
      (m) => `
    <div style="padding:10px 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; gap:12px; align-items:center;">
      <div>
        <strong>${m.title}</strong> at ${m.company} <span class="badge">${m.portal}</span> <span class="badge badge-ok">${m.fit_score}% fit</span>
        <div style="font-size:12px; color:var(--muted);">${m.location}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <a href="${m.job_url}" target="_blank" class="btn btn-sm btn-primary">Apply Now</a>
      </div>
    </div>`
    )
    .join("") || "<p style='color:var(--muted);font-size:14px;'>Queue is empty. Loops run every 4 hours.</p>";
}

// Event Listeners
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.remove("hidden");
  });
});

$("login-btn").addEventListener("click", async () => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: $("auth-email").value.trim(),
    password: $("auth-password").value,
  });
  if (error) return showMsg("auth-status", error.message, true);
  currentUser = data.user;
  $("auth-section").classList.add("hidden");
  $("app-section").classList.remove("hidden");
  await loadUserData();
});

$("signup-btn").addEventListener("click", async () => {
  const { error } = await supabase.auth.signUp({
    email: $("auth-email").value.trim(),
    password: $("auth-password").value,
  });
  if (error) return showMsg("auth-status", error.message, true);
  showMsg("auth-status", "Account created! Check your email or sign in.");
});

$("logout-btn").addEventListener("click", async () => {
  await supabase.auth.signOut();
  location.reload();
});

$("create-loop-btn").addEventListener("click", async () => {
  const { data: existing } = await supabase.from("loops").select("id").eq("user_id", currentUser.id);
  if ((existing || []).length >= currentProfile.max_loops) {
    return showMsg("loop-status", `Plan limit reached (${currentProfile.max_loops} loops). Upgrade via UPI.`, true);
  }
  const portals = [...document.querySelectorAll("#portal-checks input:checked")].map((i) => i.value);
  const atsTokens = $("loop-ats").value.split(",").map((s) => s.trim()).filter(Boolean);
  const { error } = await supabase.from("loops").insert({
    user_id: currentUser.id,
    title: $("loop-title").value.trim(),
    location: $("loop-location").value.trim(),
    keywords: $("loop-keywords").value.trim(),
    portals,
    ats_tokens: atsTokens,
  });
  if (error) return showMsg("loop-status", error.message, true);
  showMsg("loop-status", "Loop created!");
  await loadLoops();
});

$("save-tpl-btn").addEventListener("click", async () => {
  const { error } = await supabase.from("email_templates").insert({
    user_id: currentUser.id,
    name: $("tpl-name").value.trim(),
    subject: $("tpl-subject").value.trim(),
    body: $("tpl-body").value,
  });
  if (error) return showMsg("tpl-status", error.message, true);
  showMsg("tpl-status", "Template saved!");
  await loadTemplates();
});

$("save-prof-btn").addEventListener("click", async () => {
  const { error } = await supabase
    .from("profiles")
    .update({
      full_name: $("prof-name").value.trim(),
      cv_text: $("prof-cv").value,
      candidate_profile: {
        phone: $("prof-phone").value.trim(),
        notice_period_days: Number($("prof-notice").value || 30),
        experience_years: Number($("prof-exp").value || 0),
        current_ctc_lpa: $("prof-cctc").value.trim(),
        expected_ctc_lpa: $("prof-ectc").value.trim(),
        skills: $("prof-skills").value.split(",").map((s) => s.trim()).filter(Boolean),
      },
    })
    .eq("id", currentUser.id);
  if (error) return showMsg("prof-status", error.message, true);
  showMsg("prof-status", "Profile saved!");
});

document.querySelectorAll(".select-plan-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("upi-plan").value = btn.dataset.plan;
    renderUpiQr(btn.dataset.plan);
  });
});

$("upi-plan").addEventListener("change", (e) => renderUpiQr(e.target.value));

$("submit-upi-btn").addEventListener("click", async () => {
  const res = await fetch(`${cfg.WORKER_API_URL}/api/upi-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: $("upi-email").value.trim(),
      requested_plan: $("upi-plan").value,
      utr_number: $("upi-utr").value.trim(),
    }),
  });
  const data = await res.json();
  if (!res.ok) return showMsg("upi-status", data.error || "Failed to submit.", true);
  showMsg("upi-status", data.message);
});

// Init
renderUpiQr("pro");
supabase.auth.getSession().then(async ({ data }) => {
  if (data.session?.user) {
    currentUser = data.session.user;
    $("auth-section").classList.add("hidden");
    $("app-section").classList.remove("hidden");
    await loadUserData();
  }
});
