// Script de conteúdo VoiceForm
// Detecta inputs de formulário, os lê via síntese de fala, preenche via reconhecimento de fala.
// Limpeza de PLN usa `compromise` (carregado como compromise.min.js).

(() => {
  const state = {
    fields: [],
    index: 0,
    active: false,
    recognition: null,
    overlay: null,
  };

  // ---------- Sobreposição UI ----------
  function ensureOverlay() {
    if (state.overlay) return state.overlay;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("overlay.css");
    document.head.appendChild(link);

    const el = document.createElement("div");
    el.id = "vf-overlay";
    el.innerHTML = `
      <div class="vf-title">🎙️ VoiceForm</div>
      <div class="vf-status" id="vf-status">Pronto.</div>
    `;
    document.body.appendChild(el);
    state.overlay = el;
    return el;
  }

  function setStatus(msg) {
    ensureOverlay();
    const s = document.getElementById("vf-status");
    if (s) s.textContent = msg;
  }

  // ---------- Descoberta de campos ----------
  function discoverFields() {
    const selector = 'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select';
    const nodes = Array.from(document.querySelectorAll(selector)).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly;
    });
    return nodes.map((el) => ({ el, label: getLabel(el), type: inferType(el) }));
  }

  function getLabel(el) {
    if (el.labels && el.labels.length) return el.labels[0].innerText.trim();
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    if (el.placeholder) return el.placeholder;
    if (el.name) return el.name.replace(/[-_]/g, " ");
    return "Campo sem título";
  }

  function inferType(el) {
    const t = (el.type || el.tagName).toLowerCase();
    if (["email", "tel", "number", "date", "url", "password"].includes(t)) return t;
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA") return "textarea";
    return "text";
  }

  // ---------- Síntese de fala ----------
  function speak(text) {
    return new Promise((resolve) => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1;
        u.onend = resolve;
        u.onerror = resolve;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      } catch (e) {
        resolve();
      }
    });
  }

  // ---------- Reconhecimento de fala ----------
  function getRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = navigator.language || "en-US";
    r.continuous = false;
    r.interimResults = false;
    return r;
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const r = getRecognition();
      if (!r) return reject(new Error("SpeechRecognition not supported in this browser."));
      state.recognition = r;
      r.onresult = (e) => resolve(e.results[0][0].transcript);
      r.onerror = (e) => reject(e.error);
      r.onend = () => { state.recognition = null; };
      r.start();
    });
  }

  // ---------- Normalização de PLN (compromise) ----------
  function normalize(transcript, type) {
    const nlp = window.nlp;
    let value = transcript.trim();
    if (!nlp) return value;
    const doc = nlp(value);

    if (type === "email") {
      // "john at gmail dot com" → "john@gmail.com"
      value = value.toLowerCase().replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s+/g, "");
    } else if (type === "tel" || type === "number") {
      const nums = doc.numbers().toNumber().out("array");
      value = nums.length ? nums.join("") : value.replace(/[^\d+]/g, "");
    } else if (type === "date") {
      const d = doc.dates().out("array")[0];
      if (d) value = d;
    } else {
      // Capitalize sentences for free text
      value = doc.sentences().toTitleCase ? doc.sentences().toTitleCase().out("text") : value;
    }
    return value;
  }

  // ---------- Preenchimento ----------
  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------- Loop principal ----------
  async function runSession() {
    state.fields = discoverFields();
    if (!state.fields.length) {
      setStatus("Nenhum campo de formulário encontrado nesta página.");
      await speak("Nenhum campo de formulário encontrado nesta página.");
      return;
    }
    setStatus(`${state.fields.length} campo(s) encontrado(s). Começando…`);
    await speak(`${state.fields.length} campos encontrados. Vamos começar.`);

    state.active = true;
    for (state.index = 0; state.index < state.fields.length && state.active; state.index++) {
      const f = state.fields[state.index];
      f.el.classList.add("vf-highlight");
      f.el.scrollIntoView({ behavior: "smooth", block: "center" });
      setStatus(`Campo ${state.index + 1}/${state.fields.length}: ${f.label}`);
      await speak(`${f.label}. Por favor, responda.`);

      try {
        const transcript = await listen();
        const value = normalize(transcript, f.type);
        setValue(f.el, value);
        setStatus(`Preenchido "${f.label}" com: ${value}`);
      } catch (err) {
        setStatus(`Pulado "${f.label}" (${err.message || err})`);
        await speak(`Pulando ${f.label}.`);
      } finally {
        f.el.classList.remove("vf-highlight");
      }
    }
    setStatus("Sessão concluída.");
    await speak("Tudo pronto.");
    state.active = false;
  }

  function stop() {
    state.active = false;
    try { state.recognition?.stop(); } catch {}
    try { speechSynthesis.cancel(); } catch {}
    setStatus("Parado.");
  }

  // ---------- Mensagens ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "VF_SCAN") {
      const fields = discoverFields();
      ensureOverlay();
      setStatus(`${fields.length} campo(s) detectado(s).`);
    } else if (msg.type === "VF_START" || msg.type === "VF_TOGGLE") {
      if (state.active) stop();
      else runSession();
    } else if (msg.type === "VF_STOP") {
      stop();
    }
  });
})();