chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "JOBBY_NEED_HELP") {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      title: "Jobby Needs Your Help",
      message: msg.reason || "Please solve the CAPTCHA, OTP, or custom field in the active tab.",
      priority: 2,
    });
  }
});
