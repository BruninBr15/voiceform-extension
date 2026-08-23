const send = (type) => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type });
  });
};
document.getElementById("scan").addEventListener("click", () => send("VF_SCAN"));
document.getElementById("start").addEventListener("click", () => send("VF_START"));
document.getElementById("stop").addEventListener("click", () => send("VF_STOP"));