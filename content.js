// Script de conteúdo VoiceForm
// Detecta inputs de formulário, os lê via síntese de fala, preenche via reconhecimento de fala.
// A normalização usa `compromise` quando ele estiver disponível na página.

(() => {
  const state = {
    fields: [],
    index: 0,
    active: false,
    recognition: null,
    overlay: null,
    badgeLayer: null,
    badges: [],
    badgeListenersAttached: false,
    badgeRaf: null,
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

    // >>> ALTERADO: fallback quando o atributo `type` não é confiável <<<
    // Alguns formulários usam type="text" com máscara/validação própria,
    // então tentamos inferir pelo name/id/autocomplete/placeholder também.
    const hint = `${el.name || ""} ${el.id || ""} ${el.autocomplete || ""} ${el.placeholder || ""}`.toLowerCase();
    if (/e-?mail/.test(hint)) return "email";
    if (/senha|password|\bpass\b/.test(hint)) return "password";
    // <<< FIM DA ALTERAÇÃO >>>

    return "text";
  }

  function discoverFields() {
    const writableTypes = [
      "text", "email", "tel", "number", "password",
      "url", "search"
    ];
    const inputSelector = writableTypes.map(t => `input[type=${t}]`).join(", ");
    // input without a "type" attribute defaults to text, so we include it too
    const selector = `${inputSelector}, input:not([type]), textarea , select`;

    const nodes = Array.from(document.querySelectorAll(selector)).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly;
    });
    return nodes.map((el) => ({ el, label: getLabel(el), type: inferType(el) }));
}

  // ---------- Numeração dos campos (badges) ----------
  const BADGE_SIZE = 24;

  function ensureBadgeLayer() {
    if (state.badgeLayer) return state.badgeLayer;
    const layer = document.createElement("div");
    layer.id = "vf-badge-layer";
    document.body.appendChild(layer);
    state.badgeLayer = layer;
    return layer;
  }
 
  function positionBadges() {
    state.fields.forEach((f, i) => {
      const b = state.badges[i];
      if (!b) return;
      const r = f.el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      b.style.display = visible ? "block" : "none";
      if (!visible) return;
 
      // À esquerda do campo; se não houver espaço, fica dentro do campo.
      let left = r.left - BADGE_SIZE - 6;
      if (left < 2) left = r.left + 4;
 
      // Centralizado verticalmente (em textarea grande, fica perto do topo).
      const offset = Math.min(r.height / 2, 20);
      b.style.left = `${left}px`;
      b.style.top = `${r.top + offset - BADGE_SIZE / 2}px`;
    });
  }
 
  function schedulePositionBadges() {
    if (state.badgeRaf) return;
    state.badgeRaf = requestAnimationFrame(() => {
      state.badgeRaf = null;
      positionBadges();
    });
  }
 
  function renderBadges(fields) {
    clearBadges();
    const layer = ensureBadgeLayer();
    state.fields = fields;
    state.badges = fields.map((_, i) => {
      const b = document.createElement("div");
      b.className = "vf-badge";
      b.textContent = String(i + 1);
      layer.appendChild(b);
      return b;
    });
 
    if (!state.badgeListenersAttached) {
      window.addEventListener("scroll", schedulePositionBadges, true);
      window.addEventListener("resize", schedulePositionBadges);
      state.badgeListenersAttached = true;
    }
    positionBadges();
  }
 
  function clearBadges() {
    state.badges.forEach((b) => b.remove());
    state.badges = [];
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
    r.lang = "pt-BR";
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
  // ---------- DICIONARIO DE PONTUAÇÕES ----------
  const KEY_WORDS={
  "arroba": "@",
  "ponto de exclamação": "!",
  "exclamação": "!",
  "ponto de interrogação": "?",
  "interrogação": "?",
  "vírgula": ",",
  "ponto": ".",
  };

  function replaceKeyWords(text) {
    let result =text;
    for (const[word, symbol] of Object.entries(KEY_WORDS)){
      const regex = RegExp(`\\b${word}\\b`, "gi");
      result = result.replace(regex,symbol);
    }
    return result;
  }
  // ---------- Normalização de PLN (compromise) /   ----------
  function normalize(transcript, type) {
    let value = transcript.trim();
    value = replaceKeyWords(value);

    // Email e senha precisam ficar sem espaços, com ou sem `compromise` disponível
    if (type === "email") {
      // "john at gmail dot com" → "john@gmail.com"
      return value.toLowerCase().replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s+/g, "");
    }
    if (type === "password") {
      // junta tudo o que foi dito (voz costuma separar letras/palavras com espaços)
      return value.replace(/\s+/g, "");
    }

    const nlp = window.nlp;
    if (!nlp) return value;
    const doc = nlp(value);

    if (type === "tel" || type === "number") {
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

  // ---------- Resumo da sessão ----------
  function describeField(f, n) {
    if (f.skipped || f.value === undefined) {
      return `Campo ${n}, ${f.label}: não preenchido.`;
    }
    // Senha nunca é lida em voz alta
    if (f.type === "password") {
      return `Campo ${n}, ${f.label}: preenchido. Por segurança, não será lido em voz alta.`;
    }
    let spoken = f.value;
    if (f.type === "email") {
      spoken = spoken.replace(/@/g, " arroba ").replace(/\./g, " ponto ");
    }
    return `Campo ${n}, ${f.label}: ${spoken}.`;
  }

  async function speakSummary() {
    setStatus("Resumo da sessão…");
    await speak("Resumo do preenchimento.");
    for (let i = 0; i < state.fields.length && state.active; i++) {
      await speak(describeField(state.fields[i], i + 1));
    }
  }

  // ---------- Loop principal ----------
  async function runSession() {
    const fields = discoverFields();
    renderBadges(fields); // mostra os números e guarda em state.fields

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
      const n = state.index + 1;
      f.el.classList.add("vf-highlight");
      f.el.scrollIntoView({ behavior: "smooth", block: "center" });
      setStatus(`Campo ${n}/${state.fields.length}: ${f.label}`);
      await speak(`Campo ${n}, ${f.label}. Por favor, responda.`);

      try {
        const transcript = await listen();
        const value = normalize(transcript, f.type);
        setValue(f.el, value);
        f.value = value;
        setStatus(`Preenchido "${f.label}" com: ${value}`);
      } catch (err) {
        f.skipped = true;
        setStatus(`Pulado "${f.label}" (${err.message || err})`);
        await speak(`Pulando ${f.label}.`);
      } finally {
        f.el.classList.remove("vf-highlight");
      }
    }
    setStatus("Sessão concluída.");
    if (state.active) await speakSummary();
    await speak("Tudo pronto.");
    state.active = false;
  }

  function stop() {
    state.active = false;
    try { state.recognition?.stop(); } catch {}
    try { speechSynthesis.cancel(); } catch {}
    clearBadges();
    setStatus("Parado.");
  }

  // ---------- Mensagens ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "VF_SCAN") {
      const fields = discoverFields();
      renderBadges(fields);
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