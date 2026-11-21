const fields = ["full_name", "email", "phone", "notice_days", "expected_ctc"];

chrome.storage.local.get(["jobbyProfile"], ({ jobbyProfile }) => {
  if (!jobbyProfile) return;
  for (const f of fields) {
    if (jobbyProfile[f] !== undefined) {
      document.getElementById(f).value = jobbyProfile[f];
    }
  }
});

document.getElementById("save-btn").addEventListener("click", () => {
  const profile = {};
  for (const f of fields) {
    profile[f] = document.getElementById(f).value.trim();
  }
  chrome.storage.local.set({ jobbyProfile: profile }, () => {
    document.getElementById("status").textContent = "Profile saved locally.";
  });
});

document.getElementById("fill-btn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "JOBBY_RUN_FILL" }, (resp) => {
    if (chrome.runtime.lastError) {
      document.getElementById("status").textContent = "Open a supported job portal tab first.";
      return;
    }
    document.getElementById("status").textContent = resp?.status || "Running Jobby Bot...";
  });
});
