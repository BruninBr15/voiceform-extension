// Service worker de fundo — mantém atalho + hooks de ciclo de vida para depois.
chrome.runtime.onInstalled.addListener(() => {
  console.log("VoiceForm instalado");
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "alternar-voiceform") {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "VF_TOGGLE" });
    });
  }
});