/**
 * Jobby Content Script:
 *  1. Detects Company Portal Sign-Up / Create Account forms -> auto-generates & stores password locally
 *  2. Fills standard application fields (Name, Email, Phone, Notice Period, Expected CTC)
 *  3. Detects OTP, CAPTCHA, or unknown required fields -> pauses & shows "Jobby Needs Your Help" banner
 */

function generatePortalPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$";
  let out = "Jb!";
  for (let i = 0; i < 12; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function setNativeValue(el, value) {
  if (!el || value === undefined || value === null || value === "") return;
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function detectBlocker() {
  const captcha = document.querySelector(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], [data-sitekey]'
  );
  if (captcha) return "CAPTCHA detected — please solve it and click Resume Jobby.";

  const inputs = [...document.querySelectorAll("input")];
  for (const inp of inputs) {
    const hint = `${inp.name} ${inp.id} ${inp.placeholder} ${inp.getAttribute("aria-label") || ""}`.toLowerCase();
    if (/(otp|verification|verify.?code|security.?code)/.test(hint) && !inp.value) {
      inp.style.outline = "3px solid #f59e0b";
      return "Email/SMS OTP required — enter the code and click Resume Jobby.";
    }
  }
  return null;
}

function showHelpBanner(reason, onResume) {
  let banner = document.getElementById("jobby-help-banner");
  if (banner) banner.remove();

  banner = document.createElement("div");
  banner.id = "jobby-help-banner";
  banner.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:999999;background:#0f172a;color:#fff;padding:16px;border-radius:10px;max-width:340px;box-shadow:0 10px 25px rgba(0,0,0,0.3);font-family:system-ui,sans-serif;font-size:13px;";
  banner.innerHTML = `
    <div style="font-weight:700;color:#60a5fa;margin-bottom:6px;">Jobby Needs Your Help</div>
    <div style="margin-bottom:12px;">${reason}</div>
    <button id="jobby-resume-btn" style="background:#0f62fe;color:#fff;border:none;padding:8px 12px;border-radius:6px;font-weight:600;cursor:pointer;margin-right:8px;">Resume Jobby</button>
    <button id="jobby-close-btn" style="background:#334155;color:#fff;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;">Dismiss</button>
  `;
  document.body.appendChild(banner);
  document.getElementById("jobby-resume-btn").onclick = () => {
    banner.remove();
    onResume();
  };
  document.getElementById("jobby-close-btn").onclick = () => banner.remove();
  chrome.runtime.sendMessage({ type: "JOBBY_NEED_HELP", reason });
}

async function runPortalAutoFill() {
  const { jobbyProfile = {}, portalCreds = {} } = await chrome.storage.local.get([
    "jobbyProfile",
    "portalCreds",
  ]);
  const host = location.hostname;
  const inputs = [...document.querySelectorAll("input, textarea")];

  // Check if this is a Company Portal Sign-Up / Login screen
  const passwordInputs = inputs.filter((i) => i.type === "password");
  if (passwordInputs.length >= 1) {
    let creds = portalCreds[host];
    if (!creds) {
      creds = { email: jobbyProfile.email || "", password: generatePortalPassword() };
      portalCreds[host] = creds;
      await chrome.storage.local.set({ portalCreds });
    }
    for (const pw of passwordInputs) {
      if (!pw.value) setNativeValue(pw, creds.password);
    }
  }

  // Fill standard candidate fields
  for (const el of inputs) {
    if (el.type === "hidden" || el.type === "password" || el.disabled) continue;
    const hint = `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") || ""}`.toLowerCase();

    if (/email/.test(hint) && !el.value) setNativeValue(el, jobbyProfile.email);
    else if (/(full.?name|your.?name|^name$)/.test(hint) && !el.value) setNativeValue(el, jobbyProfile.full_name);
    else if (/(phone|mobile|contact)/.test(hint) && !el.value) setNativeValue(el, jobbyProfile.phone);
    else if (/(notice)/.test(hint) && !el.value) setNativeValue(el, jobbyProfile.notice_days);
    else if (/(expected.?ctc|salary|compensation)/.test(hint) && !el.value) setNativeValue(el, jobbyProfile.expected_ctc);
  }

  // Check for human-in-the-loop blockers (OTP, CAPTCHA)
  const blocker = detectBlocker();
  if (blocker) {
    showHelpBanner(blocker, runPortalAutoFill);
    return { status: "Paused: waiting for user help." };
  }
  return { status: "Fields filled. Review & submit!" };
}

chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg?.type === "JOBBY_RUN_FILL") {
    runPortalAutoFill().then(sendResponse);
    return true;
  }
});
