// Script de conteúdo VoiceForm
// Detecta inputs de formulário, os lê via síntese de fala, preenche via reconhecimento de fala.
// A normalização usa `compromise` quando ele estiver disponível na página.

(() => {
  // >>> CORREÇÃO 1: se o script for injetado duas vezes na mesma página, existiriam
  // duas sessões disputando o único microfone (uma recebe "aborted" e pula campo) <<<
  if (window.__voiceFormLoaded) return;
  window.__voiceFormLoaded = true;
  // <<< FIM CORREÇÃO 1 >>>

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

  // >>> CORREÇÃO 8: log de diagnóstico no Console (F12). Filtre por "VoiceForm".
  // Quando tudo estiver funcionando, mude DEBUG para false. <<<
  const DEBUG = true;
  function log(...args) { if (DEBUG) console.log("[VoiceForm]", ...args); }
  // <<< FIM CORREÇÃO 8 >>>

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

  // >>> CORREÇÃO 9: pede a permissão do microfone UMA vez, antes do primeiro campo.
  // Assim o "Permitir" do navegador aparece e é respondido antes de começar a ouvir. <<<
  async function ensureMic() {
    if (!navigator.mediaDevices?.getUserMedia) return null; // página sem HTTPS: não dá para checar antes
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return null; // tudo certo
    } catch (e) {
      log("getUserMedia falhou:", e && e.name, e && e.message);
      return (e && e.name) || "erro";
    }
  }
  // <<< FIM CORREÇÃO 9 >>>

  // ---------- Reconhecimento de fala ----------
  function getRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = "pt-BR";
    r.continuous = false;
    r.interimResults = true; // CORREÇÃO 2: mostra o que está sendo ouvido enquanto você fala
    return r;
  }

const LISTEN_TIMEOUT_MS = 30000; // limite de segurança por tentativa (o Chrome já encerra sozinho após ~8s de silêncio)

function listenOnce() {
  return new Promise((resolve, reject) => {
    const r = getRecognition();
    if (!r) return reject(new Error("SpeechRecognition not supported in this browser."));
    state.recognition = r;

    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };

    // Se estourar o tempo, para a captura. Se algo já foi dito, o onresult
    // ainda dispara; senão o onend rejeita como "no-speech".
    const timer = setTimeout(() => {
      try { r.stop(); } catch {}
    }, LISTEN_TIMEOUT_MS);

    // >>> CORREÇÃO 2: só aceita resultado FINAL; os parciais aparecem no overlay <<<
    r.onaudiostart = () => { log("microfone aberto"); setStatus("🎤 Ouvindo… pode falar"); };
    r.onspeechstart = () => log("fala detectada");
    r.onresult = (e) => {
      let parcial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        log(res.isFinal ? "final:" : "parcial:", res[0].transcript);
        if (res.isFinal) return finish(resolve, res[0].transcript);
        parcial += res[0].transcript;
      }
      if (parcial) setStatus(`Ouvindo: ${parcial}`);
    };
    // <<< FIM CORREÇÃO 2 >>>
    r.onerror = (e) => { log("onerror:", e.error); finish(reject, e.error); };
    r.onend = () => {
      state.recognition = null;
      log("onend");
      finish(reject, "no-speech"); // só vale se nada resolveu antes
    };
    log("start()");
    r.start();
  });
  }

// >>> CORREÇÃO 3: antes, qualquer silêncio curto já virava "campo pulado".
// Agora tenta de novo algumas vezes antes de desistir. <<<
const LISTEN_RETRIES = 2; // tentativas extras
const RETRYABLE = ["no-speech", "aborted"];

// CORREÇÃO 10: erros que não adianta repetir nem "pular campo": explica e encerra.
const FATAL_ERRORS = {
  "not-allowed": "O microfone está bloqueado. Permita o acesso ao microfone e tente de novo.",
  "service-not-allowed": "O navegador bloqueou o reconhecimento de voz nesta página.",
  "audio-capture": "Não encontrei nenhum microfone.",
  "network": "O reconhecimento de voz do navegador não conseguiu se conectar. Verifique a internet e use o Chrome.",
  "language-not-supported": "Este navegador não suporta reconhecimento de voz em português.",
};

async function listen() {
  for (let tentativa = 0; ; tentativa++) {
    try {
      return await listenOnce();
    } catch (err) {
      const code = err && err.message ? err.message : err;
      const podeTentar = RETRYABLE.includes(code) && tentativa < LISTEN_RETRIES && state.active;
      if (!podeTentar) throw err;
      setStatus("Não ouvi nada, tentando de novo…");
      await speak("Não ouvi. Pode falar.");
      if (!state.active) throw err;
    }
  }
}
// <<< FIM CORREÇÃO 3 >>>

// ---------- Resumo da sessão ----------

// Versão falada: senha nunca é lida, email lê "arroba"/"ponto",
// telefone e número são lidos dígito a dígito.
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
  } else if (f.type === "tel" || f.type === "number") {
    // "11999998888" → "1 1 9 9 9 9 9 8 8 8 8" (lido dígito a dígito)
    spoken = spoken.replace(/\d/g, "$& ").trim();
  }
  return `Campo ${n}, ${f.label}: ${spoken}.`;
}

// Versão em texto para mostrar no overlay (senha mascarada)
function describeFieldText(f, n) {
  if (f.skipped || f.value === undefined) return `${n}. ${f.label}: (não preenchido${f.reason ? " — motivo: " + f.reason : ""})`;
  if (f.type === "password") return `${n}. ${f.label}: ••••••••`;
  return `${n}. ${f.label}: ${f.value}`;
}

// >>> CORREÇÃO: o texto do resumo no overlay virou função própria, para ser
// chamada de novo depois de cada campo corrigido <<<
function showSummaryText() {
  // Mostra o resumo no overlay (com o "Sessão concluída." no topo,
  // já que o resumo sobrescreve o texto do status)
  const statusEl = document.getElementById("vf-status");
  if (statusEl) {
    statusEl.textContent =
      "Sessão concluída.\n" +
      state.fields.map((f, i) => describeFieldText(f, i + 1)).join("\n");
    statusEl.style.whiteSpace = "pre-line";
  }
}
// <<< FIM CORREÇÃO >>>

async function speakSummary() {
  const filled = state.fields.filter((f) => !f.skipped && f.value !== undefined).length;
  const total = state.fields.length;

  showSummaryText(); // CORREÇÃO: antes este bloco estava escrito aqui dentro

  await speak(`Resumo do preenchimento. ${filled} de ${total} campos preenchidos.`);
  for (let i = 0; i < state.fields.length && state.active; i++) {
    await speak(describeField(state.fields[i], i + 1));
  }
}

// >>> CORREÇÃO: helpers de interpretação das respostas (sim/não e número do campo) <<<
const YES_RE = /\b(sim|quero|claro|pode|corrigir|isso|ok|aham|uhum|positivo|desejo)\b/i; // CORREÇÃO 5: mais formas de dizer "sim"
const NO_RE = /\b(n[ãa]o|nenhum|nenhuma|pronto|t[áa] certo|est[áa] certo)\b/i;

// O compromise só entende números em inglês, então o número do campo
// é interpretado aqui mesmo. O Chrome costuma devolver dígitos ("3"),
// mas às vezes devolve por extenso ("três").
// CORREÇÃO: chaves SEM acento, porque o texto é normalizado antes da busca.
// Inclui ordinais ("segundo") e "meia" (como se fala "seis" em telefone).
const NUM_WORDS = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
  seis: 6, meia: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
  treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16,
  dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30,
  quarenta: 40, cinquenta: 50,
  primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3,
  quarto: 4, quarta: 4, quinto: 5, quinta: 5, sexto: 6, sexta: 6,
  setimo: 7, setima: 7, oitavo: 8, oitava: 8, nono: 9, nona: 9,
  decimo: 10, decima: 10,
};

function parseFieldNumber(text) {
  // CORREÇÃO: tira acentos e pontuação ("Três." → "tres")
  const clean = text
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");

  const digits = clean.match(/\d+/);
  if (digits) return parseInt(digits[0], 10);

  // "vinte e um" → 20 + 1 = 21
  const tokens = clean.split(/\s+/).filter((t) => Object.hasOwn(NUM_WORDS, t));
  if (!tokens.length) return null;
  return tokens.reduce((sum, t) => sum + NUM_WORDS[t], 0);
}

// Ouve uma resposta; devolve "" se não houve fala (em vez de lançar erro)
async function listenSafe() {
  try {
    return await listen();
  } catch {
    return "";
  }
}
// <<< FIM CORREÇÃO >>>


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
    try { // CORREÇÃO 11: se o compromise falhar, usa o texto como foi ouvido
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
    } catch (e) {
      log("compromise falhou, usando texto puro:", e && e.message);
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

  // >>> CORREÇÃO: preenchimento de UM campo, extraído do for da runSession()
  // para ser reaproveitado tanto no preenchimento normal quanto na correção <<<
  async function fillField(f, n) {
    f.el.classList.add("vf-highlight");
    f.el.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus(`Campo ${n}/${state.fields.length}: ${f.label}`);
    await speak(`Campo ${n}, ${f.label}. Por favor, responda.`);

    const hadValue = f.value !== undefined; // CORREÇÃO 4: já tinha valor antes (caso de correção)?
    try {
      const transcript = await listen();
      const value = normalize(transcript, f.type);
      log("campo", n, "ouvido:", JSON.stringify(transcript), "→ valor:", JSON.stringify(value));
      setValue(f.el, value);
      f.value = value;
      f.skipped = false; // CORREÇÃO: um campo antes pulado passa a contar como preenchido
      f.reason = undefined;
      setStatus(`Preenchido "${f.label}" com: ${value}`);
    } catch (err) {
      if (!state.active) return; // CORREÇÃO: sessão foi parada, não tratar como campo pulado

      log("erro no campo", n, f.label, "→", err);
      f.reason = String((err && err.message) || err); // CORREÇÃO 10: guarda o motivo para o resumo

      // CORREÇÃO 6/10: erro que se repetiria em todos os campos → avisa e encerra a sessão.
      if (typeof err === "string" && Object.hasOwn(FATAL_ERRORS, err)) {
        setStatus(`${FATAL_ERRORS[err]} (${err})`);
        await speak(FATAL_ERRORS[err]);
        state.active = false;
        return;
      }

      // CORREÇÃO 4: numa correção que falhou, o valor antigo continua no campo;
      // então não pode virar "não preenchido".
      if (!hadValue) f.skipped = true;
      setStatus(hadValue ? `Mantido "${f.label}" (nada ouvido)` : `Pulado "${f.label}" (${err.message || err})`);
      await speak(hadValue ? `Mantendo o valor anterior de ${f.label}.` : `Pulando ${f.label}.`);
    } finally {
      f.el.classList.remove("vf-highlight");
    }
  }
  // <<< FIM CORREÇÃO >>>

  // >>> CORREÇÃO: laço de perguntas após o resumo <<<
  // "Deseja corrigir?" → sim → "Qual o número do campo?" → preenche de novo
  // → pergunta outra vez, até a resposta ser "não" (ou silêncio).
  async function correctionLoop() {
    while (state.active) {
      setStatus("Deseja corrigir alguma informação? (diga sim ou não)");
      await speak("Deseja corrigir alguma informação?");
      if (!state.active) return;

      const answer = await listenSafe();
      if (!state.active) return;

      // Só continua com "sim" claro; "não" ou silêncio encerram
      if (!(YES_RE.test(answer) && !NO_RE.test(answer))) return;

      // CORREÇÃO: até 2 tentativas para ouvir o número, mostrando no overlay
      // o que o navegador entendeu (ajuda a diagnosticar o reconhecimento)
      let n = null;
      for (let tentativa = 0; tentativa < 2 && state.active; tentativa++) {
        setStatus("Qual o número do campo?");
        await speak(tentativa === 0 ? "Qual o número do campo?" : "Não entendi. Diga só o número do campo.");
        if (!state.active) return;

        const numText = await listenSafe();
        if (!state.active) return;

        setStatus(`Ouvi: "${numText || "(nada)"}"`);
        const parsed = parseFieldNumber(numText);
        if (parsed && parsed >= 1 && parsed <= state.fields.length) {
          n = parsed;
          break;
        }
      }
      if (!n) {
        await speak(`Não consegui entender. Os campos vão de 1 a ${state.fields.length}.`);
        continue; // volta e pergunta de novo se quer corrigir
      }

      await fillField(state.fields[n - 1], n);
      if (!state.active) return;
      showSummaryText(); // atualiza o resumo na tela com o novo valor
    }
  }
  // <<< FIM CORREÇÃO >>>

  async function runSession() {
  state.active = true; // CORREÇÃO 7: marcado já no início (antes ficava só depois da fala de abertura)
  const fields = discoverFields();
  renderBadges(fields); // mostra os números e guarda em state.fields

  if (!state.fields.length) {
    setStatus("Nenhum campo de formulário encontrado nesta página.");
    await speak("Nenhum campo de formulário encontrado nesta página.");
    state.active = false;
    return;
  }
  // CORREÇÃO 9: checa/pede o microfone antes de começar
  const micErro = await ensureMic();
  if (!state.active) return;
  if (micErro) {
    const msg = micErro === "NotFoundError"
      ? "Não encontrei nenhum microfone."
      : "Não consegui acessar o microfone. Permita o acesso e tente de novo.";
    setStatus(`${msg} (${micErro})`);
    await speak(msg);
    state.active = false;
    return;
  }

  setStatus(`${state.fields.length} campo(s) encontrado(s). Começando…`);
  await speak(`${state.fields.length} campos encontrados. Vamos começar.`);

  for (state.index = 0; state.index < state.fields.length && state.active; state.index++) {
    // CORREÇÃO: o corpo do loop agora está em fillField()
    await fillField(state.fields[state.index], state.index + 1);
  }

  if (state.active) {
    await speakSummary();
    await correctionLoop(); // CORREÇÃO: pergunta se deseja corrigir algum campo
    if (state.active) await speak("Tudo pronto.");
  }
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