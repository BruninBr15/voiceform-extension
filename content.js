// Script de conteúdo do VoiceForm
// Possui toda a lógica de funcionamento da extensão

(() => {

  if (window.__voiceFormLoaded) return;
  window.__voiceFormLoaded = true; //Objeto window recebe true se for carregado, parando um segundo carregamento através do return acima.

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

  //log de diagnóstico no Console (F12). Filtrar por "VoiceForm".
  //Mudar para falso ao finalizar o debugging
  const DEBUG = true;
  function log(...args) { if (DEBUG) console.log("[VoiceForm]", ...args); }

  // ---------- UI do VoiceForm ----------
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
    if (el.name) return el.name.replace(/[-_]/g, " "); //normalização para hífen e underline virarem espaço.
    return "Campo sem título";
  }

  function inferType(el) {
    const t = (el.type || el.tagName).toLowerCase();
    if (["email", "tel", "number", "date", "url", "password"].includes(t)) return t;
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA") return "textarea";

    // Caso não seja possível identificar o tipo pela tag e pelo type...
    // então tentamos pelo: name/id/autocomplete/placeholder.
    const hint = `${el.name || ""} ${el.id || ""} ${el.autocomplete || ""} ${el.placeholder || ""}`.toLowerCase();
    if (/e-?mail/.test(hint)) return "email";
    if (/senha|password|\bpass\b/.test(hint)) return "password";

    return "text";
  }

  function discoverFields() {
    const writableTypes = [
      "text", "email", "tel", "number", "password",
      "url", "search"
    ];
    const inputSelector = writableTypes.map(t => `input[type=${t}]`).join(", "); // o map transforma cada tipo em um seletor CSS e o join junta tudo.
    // inputs sem tipo precisam ser tratados separadamente, pois o seletor não pega estes inputs.
    const selector = `${inputSelector}, input:not([type]), textarea , select`;

    const nodes = Array.from(document.querySelectorAll(selector)).filter((el) => { // conversão de NodeList criado pelo querySelectorAll para um Array.
      const r = el.getBoundingClientRect(); //retorna o tamanho e aposição do el.
      return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly; // descarte de campos invsíveis, desabilitado e somente para leitura.
    });
    return nodes.map((el) => ({ el, label: getLabel(el), type: inferType(el) }));
}

  // ---------- Numeração dos campos (badges) ----------
  const BADGE_SIZE = 24;

  function ensureBadgeLayer() { //uma única div para todos os badges.
    if (state.badgeLayer) return state.badgeLayer; // caso exista uma camada para os badges, ele é reaproveitado.
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
      const r = f.el.getBoundingClientRect(); // posição do campo
      const visible = r.width > 0 && r.height > 0; // caso o campo esteja visível, o badge aparece.
      b.style.display = visible ? "block" : "none";
      if (!visible) return;

      // Para campos aninhados horizontalmente, se não houver espaço ele fica dentro do campo.
      let left = r.left - BADGE_SIZE - 6;
      if (left < 2) left = r.left + 4;

      // Centralização vetical.
      const offset = Math.min(r.height / 2, 20);
      b.style.left = `${left}px`;
      b.style.top = `${r.top + offset - BADGE_SIZE / 2}px`;
    });
  }

  function schedulePositionBadges() { // controle do cálculo de posição, já que o scroll dispara vários eventos de uma só vez.
    if (state.badgeRaf) return;
    state.badgeRaf = requestAnimationFrame(() => { // um cáculo por frame
      state.badgeRaf = null;
      positionBadges();
    });
  }

  function renderBadges(fields) {
    clearBadges();
    const layer = ensureBadgeLayer();
    state.fields = fields; // lista de campos salva
    state.badges = fields.map((_, i) => {
      const b = document.createElement("div");
      b.className = "vf-badge";
      b.textContent = String(i + 1);
      layer.appendChild(b);
      return b;
    });

    if (!state.badgeListenersAttached) { //evitar vários listeners de scroll e resize
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
    return new Promise((resolve) => { // a garantia de que a fala acabou
      try {
        const u = new SpeechSynthesisUtterance(text); // chamada da função do WebSpeechAPI
        u.rate = 1; // taxa padrão de fala
        u.onend = resolve;
        u.onerror = resolve; // a função é resolvida mesmo após um erro para não trava a sessão
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      } catch (e) {
        resolve();
      }
    });
  }

  // Permição para o Microfone antes de iniciar a sessão.
  async function ensureMic() {
    if (!navigator.mediaDevices?.getUserMedia) return null; // página sem HTTPS o navigator.mediaDevices retorna undefined, o ? evita erro nesses casos.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // aviso de permissão
      stream.getTracks().forEach((t) => t.stop()); // liberação do microfone
      return null; // tudo certo
    } catch (e) {
      log("getUserMedia falhou:", e && e.name, e && e.message);
      return (e && e.name) || "erro";
    }
  }

  // ---------- Reconhecimento de fala ----------
  function getRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; // duas versões da API.
    if (!SR) return null;
    const r = new SR();
    r.lang = "pt-BR";
    r.continuous = false; // um campo por vez, após uma fala o reconhecimento termina.
    r.interimResults = true; // mostra o que está sendo escutado no overlay.
    return r;
  }

const LISTEN_TIMEOUT_MS = 30000; // limite de segurança por tentativa (o Chrome já encerra sozinho após 8s de silêncio)

function listenOnce() {
  return new Promise((resolve, reject) => {
    const r = getRecognition();
    if (!r) return reject(new Error("SpeechRecognition not supported in this browser."));
    state.recognition = r;

    let done = false;
    const finish = (fn, value) => { // impede que indicadores diferentes compeltem a mesma operação mais de uma vez.
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };

    // Se estourar os 30s, para a captura. Se algo já foi dito, o onresult
    // ainda dispara; senão o onend rejeita como "no-speech".
    const timer = setTimeout(() => {
      try { r.stop(); } catch {}
    }, LISTEN_TIMEOUT_MS);

    r.onaudiostart = () => { log("microfone aberto"); setStatus("🎤 Ouvindo… pode falar");};
    r.onspeechstart = () => log("fala detectada");
    r.onresult = (e) => { // eventos reconhecidos até o momento.
      let parcial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) { // percorre os novos resultados.
        const res = e.results[i];
        log(res.isFinal ? "final:" : "parcial:", res[0].transcript);
        if (res.isFinal) return finish(resolve, res[0].transcript); // resolve a operação com o resultado final.
        parcial += res[0].transcript; // acumula as transcrições não definitivas
      }
      if (parcial) setStatus(`Ouvindo: ${parcial}`);
    };

    r.onerror = (e) => { log("onerror:", e.error); finish(reject, e.error); };
    r.onend = () => {
      state.recognition = null; // faz a limpa para uma nova tentativa.
      log("onend");
      finish(reject, "no-speech"); // só vale se não concluir.
    };
    log("start()");
    r.start();
  });
  }

const LISTEN_RETRIES = 2; // tentativas extras
const RETRYABLE = ["no-speech", "aborted"];

const FATAL_ERRORS = {
  "not-allowed": "O microfone está bloqueado. Permita o acesso ao microfone e tente de novo.",
  "service-not-allowed": "O navegador bloqueou o reconhecimento de voz nesta página.",
  "audio-capture": "Não encontrei nenhum microfone.",
  "network": "O reconhecimento de voz do navegador não conseguiu se conectar. Verifique a internet e use o Chrome.",
  "language-not-supported": "Este navegador não suporta reconhecimento de voz em português.",
};

async function listen() {
  for (let tentativa = 0; ; tentativa++) { // return = sucesso; throw = encerramento.
    try {
      return await listenOnce(); // retorna o texto da tentativa.
    } catch (err) {
      const code = err && err.message ? err.message : err; // normalização do erro
      const podeTentar = RETRYABLE.includes(code) && tentativa < LISTEN_RETRIES && state.active; // se um não der condição, é encerrado.
      if (!podeTentar) throw err;
      setStatus("Não ouvi nada, tentando de novo…");
      await speak("Não ouvi. Pode falar.");
      if (!state.active) throw err;
    }
  }
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
  } else if (f.type === "tel" || f.type === "number") { // "11999998888" → "1 1 9 9 9 9 9 8 8 8 8" (lido dígito a dígito)
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

function showSummaryText() { // resumo vira função para ser chamado masi vezes.
  // Mostra o resumo no overlay (com o "Sessão concluída." no topo
  const statusEl = document.getElementById("vf-status");
  if (statusEl) {
    statusEl.textContent =
      "Sessão concluída.\n" +
      state.fields.map((f, i) => describeFieldText(f, i + 1)).join("\n");
    statusEl.style.whiteSpace = "pre-line";
  }
}

async function speakSummary() {
  const filled = state.fields.filter((f) => !f.skipped && f.value !== undefined).length;
  const total = state.fields.length;

  showSummaryText();

  await speak(`Resumo do preenchimento. ${filled} de ${total} campos preenchidos.`);
  for (let i = 0; i < state.fields.length && state.active; i++) {
    await speak(describeField(state.fields[i], i + 1));
  }
}

const YES_RE = /\b(sim|quero|claro|pode|corrigir|isso|ok|aham|uhum|positivo|desejo)\b/i; // várias formas de reconhecimento das respostas.
const NO_RE = /\b(n[ãa]o|nenhum|nenhuma|pronto|t[áa] certo|est[áa] certo)\b/i;

const NUM_WORDS = { // compromise reconhece números em inglês, por isso eles são interpretados aqui.
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

function parseFieldNumber(text) { // normalização dos números: três -> tres.
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
  function normalize(transcript, type) { // texto escutado e tipo
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
    try { // se o compromise falhar, usa o texto como foi ouvido. Ainda funciona, mas limitado.
      const doc = nlp(value);

      if (type === "tel" || type === "number") {
        const nums = doc.numbers().toNumber().out("array");
        value = nums.length ? nums.join("") : value.replace(/[^\d+]/g, "");
      } else if (type === "date") {
        const d = doc.dates().out("array")[0];
        if (d) value = d;
      } else {
        // Capitaliza palavras
        value = doc.sentences().toTitleCase ? doc.sentences().toTitleCase().out("text") : value;
      }
    } catch (e) {
      log("compromise falhou, usando texto puro:", e && e.message);
    }
    return value;
  }

  // ---------- Preenchimento ----------
  function setValue(el, value) { // escrita do texto no campo
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event("input", { bubbles: true })); // ambos input e...
    el.dispatchEvent(new Event("change", { bubbles: true })); // change podem ser usados pelos sites para guardar o valor dos campos.
  }

  // preecnhimento de um campo que pode ser reaproveitado para a correção.
  async function fillField(f, n) {
    f.el.classList.add("vf-highlight"); // destaque do campo.
    f.el.scrollIntoView({ behavior: "smooth", block: "center" }); // rolagem da página.
    setStatus(`Campo ${n}/${state.fields.length}: ${f.label}`);
    await speak(`Campo ${n}, ${f.label}. Por favor, responda.`); // microfone abre depois do término da fala.

    const hadValue = f.value !== undefined;
    try {
      const transcript = await listen(); // devolve o texto falado.
      const value = normalize(transcript, f.type); // ajuste do texto pelo compromise.
      log("campo", n, "ouvido:", JSON.stringify(transcript), "→ valor:", JSON.stringify(value));
      setValue(f.el, value); // escrita no campo.
      f.value = value; // o valor é guardado para o resumo.
      f.skipped = false;
      f.reason = undefined;
      setStatus(`Preenchido "${f.label}" com: ${value}`);
    } catch (err) {
      if (!state.active) return;

      log("erro no campo", n, f.label, "→", err);
      f.reason = String((err && err.message) || err);

      // erros terminais.
      if (typeof err === "string" && Object.hasOwn(FATAL_ERRORS, err)) {
        setStatus(`${FATAL_ERRORS[err]} (${err})`);
        await speak(FATAL_ERRORS[err]);
        state.active = false;
        return;
      }

      // numa correção que falhou, o valor antigo continua no campo;
      if (!hadValue) f.skipped = true;
      setStatus(hadValue ? `Mantido "${f.label}" (nada ouvido)` : `Pulado "${f.label}" (${err.message || err})`);
      await speak(hadValue ? `Mantendo o valor anterior de ${f.label}.` : `Pulando ${f.label}.`);
    } finally {
      f.el.classList.remove("vf-highlight"); // limpeza do destaque do campo
    }
  }

  // ---------- Loop de Correção ----------
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

      let n = null;
      for (let tentativa = 0; tentativa < 2 && state.active; tentativa++) { // 2 tentativas para responder o número do campo.
        setStatus("Qual o número do campo?");
        await speak(tentativa === 0 ? "Qual o número do campo?" : "Não entendi. Diga só o número do campo.");
        if (!state.active) return;

        const numText = await listenSafe();
        if (!state.active) return;

        setStatus(`Ouvi: "${numText || "(nada)"}"`);
        const parsed = parseFieldNumber(numText);
        if (parsed && parsed >= 1 && parsed <= state.fields.length) { // rejeita null -> não entendeu e números fora do intervalo, como 0.
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
      showSummaryText(); // atualiza o resumo na tela com o novo valor ou mantém o antigo se houver falha.
    }
  }

  // ---------- Sessão ----------
  async function runSession() {
    state.active = true; // "liga" tudo.
    const fields = discoverFields(); // descoberta dos campos
    renderBadges(fields); // mostra os números e guarda em state.fields.

    if (!state.fields.length) {
      setStatus("Nenhum campo de formulário encontrado nesta página.");
      await speak("Nenhum campo de formulário encontrado nesta página.");
      state.active = false;
      return;
    }
    // pede o microfone antes de começar
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

    //loop principal
    for (state.index = 0; state.index < state.fields.length && state.active; state.index++) {
      await fillField(state.fields[state.index], state.index + 1); // o await espera o fim de cada campo
    }

    if (state.active) {
      await speakSummary();
      await correctionLoop(); // pergunta se deseja corrigir algum campo
      if (state.active) await speak("Tudo pronto.");
    }
    state.active = false; // encerramento da sessão para o início de outra.
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