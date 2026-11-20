// ClawdDesk — app principal: conexão em tempo real, renderização, alertas e modo mesa.
import { Mascot } from './mascot.js';
import { Sfx } from './audio.js';
import { KeepAwake } from './keepawake.js';
import { Theme, THEME_ICON, THEME_LABEL } from './theme.js';
import { startBurnInShift } from './burnin.js';
import { SimPanel } from './simulate.js';
import { fmtDuration, fmtTokens, fmtUsd, fmtBrl, fmtClock, fmtDate, fmtWhen, fmtPct, fmtWork, fmtDayMonth } from './format.js';
import { PROJECT_COLORS, projectColor, miniRobot } from './colors.js';

// custo em dólar e em reais (cotação vinda do PC)
let fx = null;
const money = (usd) => {
  if (usd == null || !isFinite(usd)) return '—';
  const brl = fx ? fmtBrl(usd, fx.usdBrl) : '';
  return brl ? fmtUsd(usd) + ' · ' + brl : fmtUsd(usd);
};
const fxNote = () =>
  fx
    ? 'Custo equivalente na API. Cotação: US$ 1 = ' + fmtBrl(1, fx.usdBrl) + ' (' + fx.source + ', ' + fmtClock(new Date(fx.at)) + ')'
    : 'Custo equivalente na API';

// cor do projeto: índice fixo vindo do PC (sem repetir entre projetos); se faltar, hash do nome
const colorOf = (x) =>
  !x ? PROJECT_COLORS[0] : (Number.isInteger(x.colorIndex) && PROJECT_COLORS[x.colorIndex]) || projectColor(x.project || x.name || '');

const $ = (id) => document.getElementById(id);
const body = document.body;
const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

const sfx = new Sfx();
const mascot = new Mascot($('mascot'), $('particles'));
const awake = new KeepAwake(sfx, () => renderTop());
const theme = new Theme(() => {
  awake.setBackground(theme.background);
  renderTop();
});
awake.setBackground(theme.background);
const sim = new SimPanel($('sim-panel'), sfx, { onPair: () => openPair() });

// pareamento para aprovar pedidos pelo celular (token guardado só neste aparelho)
const local = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};
let token = local.get('cd.token');
let paired = false;

let snap = null;
let clockOffset = 0; // relógio do PC − relógio do celular
let connected = false;
let connecting = false;
let lastMsgAt = 0;
let disconnectedAt = Date.now();
let ws = null;
let helloSent = false;
let retry = 0;
let retryTimer = null;
const alerted = new Set();
let prevLevels = null;
const reminder = { key: null, count: 0, timer: null };

const now = () => Date.now() + clockOffset;
const level = (pct) => (pct == null ? 0 : pct >= 95 ? 2 : pct >= 80 ? 1 : 0);
const setText = (el, v) => {
  v = v == null ? '' : String(v);
  if (el.textContent !== v) el.textContent = v;
};

// ---------------------------------------------------------------- conexão
function connect() {
  if (connecting || connected) return;
  connecting = true;
  clearTimeout(retryTimer);
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  try {
    ws = new WebSocket(url);
  } catch {
    connecting = false;
    return scheduleReconnect();
  }
  ws.onopen = () => {
    helloSent = false;
    connecting = false;
    connected = true;
    retry = 0;
    lastMsgAt = Date.now();
    render();
  };
  ws.onmessage = (ev) => {
    lastMsgAt = Date.now();
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === 'snapshot') onSnapshot(m.data);
    else if (m.type === 'auth') {
      paired = !!m.paired;
      if (!paired && token) {
        token = null; // pareamento revogado no PC
        local.set('cd.token', null);
      }
      renderPairState();
      render();
    }
  };
  ws.onclose = () => {
    if (connected) disconnectedAt = Date.now();
    connected = false;
    connecting = false;
    render();
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, Math.min(10e3, 800 * Math.pow(1.6, retry++)));
}

// o servidor manda algo pelo menos a cada 30 s; se ficar mudo, reconecta
setInterval(() => {
  if (connected && Date.now() - lastMsgAt > 75e3) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}, 5e3);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !connected) {
    retry = 0;
    connect();
  }
});

function onSnapshot(s) {
  clockOffset = s.serverTime - Date.now();
  snap = s;
  fx = s.fx || null;
  checkVersion(s);
  // conta ao PC qual versão da interface este aparelho está rodando (aparece no terminal)
  if (!helloSent && bootVersion && ws && ws.readyState === 1) {
    helloSent = true;
    try {
      ws.send(JSON.stringify({ type: 'hello', version: bootVersion, token }));
    } catch {
      /* ignore */
    }
  }
  handleAlerts(s);
  render();
}

// ---------------------------------------------------------------- atualização automática
// O servidor manda a "versão" da interface. Se mudar, o celular recarrega sozinho — mas nunca
// no meio de um pedido de permissão — e volta direto para o modo mesa.
const session = {
  get(k, d) {
    try {
      const v = sessionStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};
let bootVersion = null;
let reloadTimer = null;
let activated = false;

function checkVersion(s) {
  if (!s.version) return;
  if (!bootVersion) {
    bootVersion = s.version;
    return;
  }
  if (s.version === bootVersion || reloadTimer) return;
  const recent = session.get('cd.reloads', []).filter((ts) => Date.now() - ts < 60e3);
  if (recent.length >= 3) return; // proteção contra loop de recarga
  reloadTimer = setInterval(() => {
    if (snap && snap.primary && snap.primary.state === 'permission') return; // espera o alerta acabar
    clearInterval(reloadTimer);
    session.set('cd.reloads', [...recent, Date.now()]);
    session.set('cd.resume', activated);
    showToast('🔄 Nova versão do ClawdDesk — atualizando…');
    setTimeout(() => location.reload(), 1200);
  }, 1000);
}

function showToast(text) {
  const t = $('toast');
  setText(t, text);
  t.hidden = !text;
}

// ---------------------------------------------------------------- alertas e avisos
// Avisa de TODAS as sessões abertas, não só da que está em destaque:
//  ✋ aguardando sua resposta (permissão/pergunta) · ✅ concluiu / pronta · ⚠️ parou com erro
function alertPermission() {
  sfx.play('permission');
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

function handleAlerts(s) {
  const t = now();
  const events = [];
  const waiting = [];
  for (const x of s.sessions || []) {
    const key = `${x.id}:${x.since}`;
    if (x.state === 'permission') {
      waiting.push(key);
      if (!alerted.has(key)) {
        alerted.add(key);
        events.push({ type: 'permission', x, key });
      }
    } else if (x.state === 'done' && !alerted.has(key) && t - x.since < 15e3) {
      alerted.add(key);
      events.push({ type: x.lastDone && x.lastDone.error ? 'error' : x.question ? 'question' : 'done', x, key });
    }
  }
  // um som por vez, pelo evento mais importante
  if (events.some((e) => e.type === 'permission')) alertPermission();
  else if (events.some((e) => e.type === 'error')) {
    sfx.play('warn80');
    if (navigator.vibrate) navigator.vibrate([300]);
  } else if (events.length) {
    sfx.play('done');
    if (navigator.vibrate) navigator.vibrate([90]);
  }
  for (const e of events) showNotice(e, t);
  // o aviso de "aguardando" some assim que a sessão é respondida
  dropNotices((n) => n.type === 'permission' && !waiting.includes(n.key));
  // lembrete a cada 60 s (no máximo 3 vezes) enquanto alguma sessão estiver esperando
  const sig = waiting.join('|');
  if (sig !== reminder.key) {
    clearInterval(reminder.timer);
    reminder.timer = null;
    reminder.key = sig;
    reminder.count = 0;
    if (waiting.length) {
      reminder.timer = setInterval(() => {
        if (++reminder.count > 3) return clearInterval(reminder.timer);
        alertPermission();
      }, 60e3);
    }
  }
  const lv = { five: level(s.usage.fiveHour.pct), seven: level(s.usage.sevenDay.pct) };
  for (const m of s.usage.models || []) lv[`m:${m.name}`] = level(m.pct);
  if (prevLevels) {
    for (const k of Object.keys(lv)) {
      if (lv[k] > (prevLevels[k] || 0)) {
        sfx.play(lv[k] === 2 ? 'warn95' : 'warn80');
        if (navigator.vibrate) navigator.vibrate(lv[k] === 2 ? [400, 120, 400] : [300]);
        flashMeter(k === 'five' ? 'm-5h' : 'm-7d');
      }
    }
  }
  prevLevels = lv;
  if (alerted.size > 200) alerted.clear();
}

// ---- pilha de avisos na tela
const notices = []; // { key, type, el, timer }
const NOTICE_TTL = { done: 20e3, error: 30e3, question: 90e3 }; // "aguardando" fica até ser respondido

function noticeContent(e) {
  const x = e.x;
  if (e.type === 'permission') {
    if (x.question && x.question.source === 'ask') {
      return { icon: '❓', title: x.project, text: x.question.text, options: x.question.options };
    }
    const what =
      x.tool && !/pergunta|plano/i.test(x.message || '') ? `${x.tool.name}: ${x.tool.target}` : x.message || 'aprovação pendente';
    return { icon: '✋', title: x.project, text: `Aguardando sua resposta · ${what}` };
  }
  if (e.type === 'question') {
    return { icon: '❓', title: `${x.project} · aguardando você`, text: x.question.text, options: x.question.options, hint: 'responda no PC' };
  }
  if (e.type === 'error') return { icon: '⚠️', title: x.project, text: 'Parou com erro da API · confira a sessão' };
  const d = x.lastDone || {};
  let text = d.duration ? `Concluiu em ${fmtDuration(d.duration, { seconds: true })}` : 'Concluiu';
  if (d.tools) text += ` · ${d.tools} ${d.tools === 1 ? 'ferramenta' : 'ferramentas'}`;
  return { icon: '✅', title: x.project, text: `${text} · pronta para o próximo pedido` };
}

function showNotice(e, t) {
  const n = noticeContent(e);
  const el = document.createElement('div');
  el.className = 'notice';
  el.dataset.type = e.type;
  el.innerHTML = '<span class="n-icon"></span><div class="n-body"><div class="n-title"></div><div class="n-text"></div></div><span class="n-time"></span>';
  el.querySelector('.n-icon').textContent = n.icon;
  el.querySelector('.n-title').textContent = n.title;
  el.querySelector('.n-text').textContent = n.text;
  el.querySelector('.n-time').textContent = fmtClock(new Date(t));
  // opções da pergunta (só para ver; a resposta é dada no PC)
  if ((n.options && n.options.length) || n.hint) {
    const box = document.createElement('div');
    box.className = 'n-opts';
    for (const o of n.options || []) {
      const chip = document.createElement('span');
      chip.className = 'n-opt';
      chip.textContent = o;
      box.appendChild(chip);
    }
    if (n.hint) {
      const h = document.createElement('span');
      h.className = 'n-hint';
      h.textContent = n.hint;
      box.appendChild(h);
    }
    el.appendChild(box);
  }
  const item = { key: e.key, type: e.type, el, timer: null, sid: e.x.id, action: null };
  if (e.type === 'permission') {
    const act = document.createElement('div');
    act.className = 'n-actions';
    el.appendChild(act);
    item.act = act;
  }
  el.addEventListener('click', () => removeNotice(item));
  if (NOTICE_TTL[e.type]) item.timer = setTimeout(() => removeNotice(item), NOTICE_TTL[e.type]);
  $('notices').prepend(el);
  notices.unshift(item);
  while (notices.length > 4) removeNotice(notices[notices.length - 1]);
}

function removeNotice(item) {
  const i = notices.indexOf(item);
  if (i < 0) return;
  notices.splice(i, 1);
  clearTimeout(item.timer);
  item.el.classList.add('out');
  setTimeout(() => item.el.remove(), 350);
}

function dropNotices(pred) {
  for (const n of notices.slice()) if (pred(n)) removeNotice(n);
}

function flashMeter(id) {
  const el = $(id);
  el.classList.remove('flash');
  void el.offsetWidth; // reinicia a animação
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 6000);
}

// ---------------------------------------------------------------- render
const RING_C = 540.35; // circunferência do arco de contexto (r = 86)
const STATE_BADGE = { idle: 'PRONTO', thinking: 'TRABALHANDO', permission: 'PRECISA DE VOCÊ', done: 'CONCLUÍDO' };

function render() {
  const t = now();
  const s = snap;
  const offline = !connected && (!s || Date.now() - disconnectedAt > 3000);
  const p = s && s.primary;
  const state = offline ? 'offline' : p ? p.state : 'idle';
  const u = s ? s.usage : null;
  const warn = u ? Math.max(level(u.fiveHour.pct), level(u.sevenDay.pct), ...(u.models || []).map((m) => level(m.pct))) : 0;
  const mood = state === 'idle' && warn > 0 ? 'warning' : state;

  body.dataset.state = state;
  body.dataset.mood = mood;
  body.dataset.warn = String(warn);
  body.dataset.sim = s && s.sim && s.sim.active ? '1' : '0';
  mascot.setMood(mood);

  renderCore(state, mood, p, s, t);
  renderFeed(p, t);
  renderLimits(u, t);
  renderSessions(s, p, t);
  renderTimeline(s);
  renderTop();
  syncNoticeActions(t);
}

// ---- Permitir / Negar dentro do aviso âmbar
function approvalFor(sid) {
  const open = snap && snap.approvals ? snap.approvals.open : [];
  return open.find((a) => a.sessionId === sid) || null;
}

function syncNoticeActions(t) {
  for (const item of notices) {
    if (!item.act) continue;
    const ap = approvalFor(item.sid);
    let mode;
    if (item.action) mode = item.action; // enviando / enviado / erro (temporário)
    else if (!ap) mode = 'pc';
    else mode = paired ? 'buttons' : 'pair';
    const left = ap ? Math.max(0, Math.round((ap.expiresAt - t) / 1000)) : 0;
    const sig = `${mode}|${ap ? ap.id : ''}|${mode === 'buttons' ? left : ''}`;
    if (item.act.dataset.sig === sig) continue;
    item.act.dataset.sig = sig;
    if (mode === 'buttons' && item.act.querySelector('.n-allow') && item.act.dataset.ap === ap.id) {
      setText(item.act.querySelector('.n-hint'), `responda aqui em ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
      continue;
    }
    item.act.dataset.ap = ap ? ap.id : '';
    item.act.textContent = '';
    const hint = document.createElement('span');
    hint.className = 'n-hint';
    if (mode === 'buttons') {
      const allow = document.createElement('button');
      allow.className = 'n-btn n-allow';
      allow.textContent = '✓ Permitir';
      const deny = document.createElement('button');
      deny.className = 'n-btn n-deny';
      deny.textContent = '✕ Negar';
      allow.addEventListener('click', (ev) => decide(ev, item, ap.id, 'allow'));
      deny.addEventListener('click', (ev) => decide(ev, item, ap.id, 'deny'));
      hint.textContent = `responda aqui em ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      item.act.append(allow, deny, hint);
    } else if (mode === 'pair') {
      const b = document.createElement('button');
      b.className = 'n-btn n-pair';
      b.textContent = '🔐 Parear para responder daqui';
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openPair();
      });
      item.act.append(b);
    } else if (mode === 'sending') {
      hint.textContent = 'Enviando…';
      item.act.append(hint);
    } else if (mode === 'allow' || mode === 'deny') {
      hint.textContent = mode === 'allow' ? '✓ Permitido pelo celular' : '✕ Negado pelo celular';
      hint.className = `n-hint n-done-${mode}`;
      item.act.append(hint);
    } else if (mode === 'error') {
      hint.textContent = item.error || 'Não deu — responda no PC';
      hint.className = 'n-hint n-err';
      item.act.append(hint);
    } else {
      hint.textContent = 'Responda no PC';
      item.act.append(hint);
    }
  }
}

async function decide(ev, item, id, decision) {
  ev.stopPropagation();
  sfx.unlock();
  item.action = 'sending';
  syncNoticeActions(now());
  try {
    const r = await fetch('/api/permission/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, decision, token }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      item.action = decision;
      sfx.play('tick');
    } else {
      if (r.status === 401) {
        token = null;
        paired = false;
        local.set('cd.token', null);
      }
      item.action = 'error';
      item.error = r.status === 410 ? 'Já respondido ou expirou — veja no PC' : j.error || 'Não deu — responda no PC';
    }
  } catch {
    item.action = 'error';
    item.error = 'Sem conexão com o PC';
  }
  syncNoticeActions(now());
  setTimeout(() => {
    if (item.action === 'error') {
      item.action = null;
      syncNoticeActions(now());
    }
  }, 6000);
}

// ---- janela de pareamento
function openPair() {
  renderPairState();
  $('pair-msg').textContent = '';
  $('pair-panel').hidden = false;
  if (!paired) setTimeout(() => $('pair-code').focus(), 50);
}

function renderPairState() {
  $('pair-form').hidden = paired;
  $('pair-done').hidden = !paired;
  sim.setPairStatus(paired);
}

async function doPair() {
  const code = $('pair-code').value.replace(/\D/g, '');
  if (code.length !== 6) return setText($('pair-msg'), 'Digite os 6 números do código.');
  setText($('pair-msg'), 'Pareando…');
  try {
    const r = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: isTouch ? 'celular' : 'navegador' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) return setText($('pair-msg'), `✕ ${j.error || 'não deu certo'}`);
    token = j.token;
    local.set('cd.token', token);
    paired = true;
    $('pair-code').value = '';
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'hello', version: bootVersion || '', token }));
    renderPairState();
    setText($('pair-msg'), '✓ Pareado! Agora os pedidos aparecem com Permitir/Negar.');
    render();
  } catch {
    setText($('pair-msg'), '✕ Sem conexão com o PC.');
  }
}

$('pair-go').addEventListener('click', doPair);
$('pair-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doPair();
});
$('pair-cancel').addEventListener('click', () => ($('pair-panel').hidden = true));
$('pair-close').addEventListener('click', () => ($('pair-panel').hidden = true));
$('pair-forget').addEventListener('click', async () => {
  try {
    await fetch('/api/unpair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  } catch {
    /* mesmo offline, esquece localmente */
  }
  token = null;
  paired = false;
  local.set('cd.token', null);
  renderPairState();
  setText($('pair-msg'), 'Este aparelho não está mais pareado.');
  render();
});

// ---- núcleo: estado da sessão em destaque
function renderCore(state, mood, p, s, t) {
  let label = 'Pronto';
  let detail = 'Aguardando comandos';
  let meta = '';
  if (state === 'offline') {
    label = 'Sem conexão';
    detail = 'Procurando o PC…';
    meta = `rode "npm start" no PC · ${location.host}`;
  } else if (mood === 'warning') {
    const u = s.usage;
    const cands = [['5h', u.fiveHour], ['Semana', u.sevenDay], ...(u.models || []).map((m) => [m.name, m])];
    const w = cands.reduce((a, b) => ((b[1].pct || 0) > (a[1].pct || 0) ? b : a));
    label = w[1].pct >= 95 ? 'Quase no limite!' : 'Uso alto!';
    detail = `${w[0]} em ${fmtPct(w[1].pct)}%`;
    meta = w[1].resetsAt ? `reinicia em ${fmtDuration(w[1].resetsAt - t)}` : '';
  } else if (state === 'idle') {
    if (!p && s && !s.hooks.count && !(s.sim && s.sim.active)) {
      detail = 'Aguardando o Claude Code';
      meta = 'no PC: npm run setup-hooks';
    } else if (p && p.lastDone) {
      meta = `última tarefa há ${fmtDuration(t - p.lastDone.at)}`;
    }
  } else if (state === 'thinking') {
    label = p.tool ? 'Trabalhando' : 'Pensando';
    detail = p.tool ? `${p.tool.icon} ${p.tool.verb} ${p.tool.target}`.trim() : '💭 Pensando…';
    const parts = [];
    if (p.turnStart) parts.push(fmtDuration(t - p.turnStart, { seconds: true }));
    if (p.toolCount) parts.push(`${p.toolCount} ${p.toolCount === 1 ? 'ferramenta' : 'ferramentas'}`);
    meta = parts.join(' · ');
  } else if (state === 'permission') {
    label = 'Precisa de você!';
    detail =
      p.tool && !/pergunta|plano/i.test(p.message || '') ? `${p.tool.icon} ${p.tool.name}: ${p.tool.target}` : p.message || 'Aguardando aprovação';
    meta = `${p.message && p.tool ? p.message + ' · ' : ''}aguardando há ${fmtDuration(t - p.since, { seconds: true })}`;
  } else if (state === 'done') {
    const d = p.lastDone || {};
    label = d.error ? 'Parou com erro' : 'Concluído!';
    const parts = [];
    if (d.duration) parts.push(`em ${fmtDuration(d.duration, { seconds: true })}`);
    if (d.tools) parts.push(`${d.tools} ${d.tools === 1 ? 'ferramenta' : 'ferramentas'}`);
    detail = parts.join(' · ') || 'Tarefa finalizada';
    meta = p.message || '';
  }
  // pergunta esperando sua resposta (app Claude, terminal ou pergunta de múltipla escolha)
  const q = p && p.question && state !== 'offline' && state !== 'thinking' ? p.question : null;
  if (q && mood !== 'warning') {
    if (state === 'idle') label = 'Aguardando você';
    detail = `❓ ${q.text}`;
    meta = `${q.options && q.options.length ? 'opções: ' + q.options.join(' · ') + ' — ' : ''}responda no PC`;
  }
  setText($('state-label'), label);
  setText($('state-detail'), detail);
  setText($('state-meta'), meta);
  setText($('core-project'), p ? `${p.project}${p.model ? ' · ' + p.model : ''}` : 'Claude Code');
  renderCoreTime(p);
  renderCoreGit(p);
  // o robô do núcleo veste a cor do projeto em destaque
  const col = colorOf(p);
  const mEl = $('mascot');
  if (mEl.dataset.color !== col.body) {
    mEl.dataset.color = col.body;
    mEl.style.setProperty('--rb-body', col.body);
    mEl.style.setProperty('--rb-shade', col.shade);
    mEl.style.setProperty('--rb-hi', col.hi);
    $('core-project').style.color = col.body;
  }

  const d = new Date(t);
  setText($('bigclock'), fmtClock(d));
  setText($('bigdate'), fmtDate(d));
  setText($('clock'), fmtClock(d));

  // anel: arco = uso de contexto da sessão em destaque
  const ctx = p && p.context;
  const pct = ctx && ctx.pct != null ? Math.max(0, Math.min(100, ctx.pct)) : 0;
  const off = (RING_C * (1 - pct / 100)).toFixed(1);
  const arc = $('ring-arc');
  if (arc.style.strokeDashoffset !== off) arc.style.strokeDashoffset = off;
  setText(
    $('ring-label'),
    state === 'offline' ? 'OFFLINE' : ctx && ctx.pct != null ? `CTX ${fmtPct(ctx.pct)}% · ${fmtTokens(ctx.used)}/${fmtTokens(ctx.size)}` : ''
  );
}

// ---- tempo trabalhado (Claude trabalhando, sem contar o tempo esperando você)
function renderCoreTime(p) {
  const el = $('core-time');
  const w = p && p.work;
  if (!w || (!w.project && !w.session)) {
    el.dataset.sig = '';
    return setText(el, '');
  }
  const parts = [];
  if (w.project) {
    parts.push(`⏱ projeto ${fmtWork(w.project.total)}`);
    parts.push(`hoje ${fmtWork(w.project.today)}`);
  }
  if (w.session && (!w.project || w.project.sessions > 1)) parts.push(`sessão ${fmtWork(w.session.total)}`);
  const extra = w.project && w.project.sessions > 1 ? ` · ${w.project.sessions} sessões desde ${fmtDayMonth(w.project.first)}` : '';
  const sig = parts.join(' · ') + '|' + extra;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.textContent = parts.join(' · ');
  if (extra) {
    const x = document.createElement('span');
    x.className = 'ct-extra'; // só aparece na vertical (na horizontal a coluna é estreita)
    x.textContent = extra;
    el.appendChild(x);
  }
  el.title = 'Tempo em que o Claude esteve trabalhando (do pedido até a última resposta), somando todas as sessões do projeto';
}

// ---- git da sessão em destaque
function gitText(g, pr) {
  if (!g && !pr) return '';
  const parts = [];
  if (g) {
    parts.push(`🌿 ${g.branch}`);
    parts.push(g.files ? `${g.files} ${g.files === 1 ? 'arquivo' : 'arquivos'} · +${g.added} −${g.removed}` : 'sem alterações');
  }
  if (pr) parts.push(`PR #${pr.number}`);
  return parts.join(' · ');
}

function renderCoreGit(p) {
  setText($('core-git'), p ? gitText(p.git, p.pr) : '');
}

// ---- linha do tempo do dia (por projeto)
function renderTimeline(s) {
  const tl = s && s.timeline;
  const live = new Set((s ? s.sessions : []).filter((x) => x.state === 'thinking' || x.state === 'permission').map((x) => x.project));
  for (const box of [$('tl-rows'), $('feed-tl')]) drawTimeline(box, tl, live);
  if (!tl) return;
  const total = tl.projects.reduce((t, p) => t + p.total, 0);
  setText($('tl-total'), total ? `⏱ ${fmtWork(total)} NO TOTAL` : '');
  setText($('tl-from'), fmtClock(new Date(tl.from)));
  setText($('tl-mid'), fmtClock(new Date(tl.from + (tl.to - tl.from) / 2)));
  setText($('tl-to'), `agora ${fmtClock(new Date(tl.to))}`);
}

function drawTimeline(box, tl, live) {
  const projects = tl ? tl.projects : [];
  const span = tl ? Math.max(1, tl.to - tl.from) : 1;
  const sig = projects.map((p) => `${p.name}:${p.total}:${p.intervals.length}:${live.has(p.name) ? 1 : 0}`).join('|') + `|${tl ? Math.floor(tl.to / 60000) : 0}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.textContent = '';
  if (!projects.length) {
    const e = document.createElement('div');
    e.className = 'tl-empty';
    e.textContent = 'O Claude ainda não trabalhou hoje.';
    box.appendChild(e);
    return;
  }
  for (const p of projects) {
    const col = colorOf(p);
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.dataset.live = live.has(p.name) ? '1' : '0';
    row.style.setProperty('--pc', col.body);
    const bot = document.createElement('span');
    bot.className = 'tl-bot';
    bot.appendChild(miniRobot(col));
    const name = document.createElement('span');
    name.className = 'tl-name';
    name.textContent = p.name;
    const track = document.createElement('div');
    track.className = 'tl-track';
    for (const [x0, x1] of p.intervals) {
      const seg = document.createElement('i');
      seg.style.left = `${(((x0 - tl.from) / span) * 100).toFixed(2)}%`;
      seg.style.width = `${Math.max(0.6, ((x1 - x0) / span) * 100).toFixed(2)}%`;
      track.appendChild(seg);
    }
    const tot = document.createElement('span');
    tot.className = 'tl-tot';
    tot.textContent = fmtWork(p.total);
    row.append(bot, name, track, tot);
    box.appendChild(row);
  }
}

// ---- histórico da sessão em destaque (mais recente primeiro)
function renderFeed(p, t) {
  setText($('feed-who'), p ? p.project : '');
  const list = $('feed');
  const items = p && p.recent ? p.recent.slice().reverse().slice(0, 6) : [];
  const sig = items.map((e) => `${e.ts}${e.verb}`).join('|') + (items.length ? '' : '-empty');
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'feed-empty';
    li.textContent = 'sem atividade ainda';
    list.appendChild(li);
    return;
  }
  for (const e of items) {
    const li = document.createElement('li');
    li.className = 'f-item';
    li.dataset.kind = e.kind || 'tool';
    const time = document.createElement('span');
    time.className = 'f-time';
    time.textContent = fmtClock(new Date(e.ts), true);
    const icon = document.createElement('span');
    icon.textContent = e.icon || '·';
    const text = document.createElement('span');
    text.className = 'f-text';
    text.textContent = `${e.verb}${e.target ? ' ' + e.target : ''}`;
    li.append(time, icon, text);
    list.appendChild(li);
  }
}

// ---- limites da conta
// faixas: 0 <60% · 1 60–80% (âmbar) · 2 80–95% (vermelho pulsante) · 3 ≥95% (alarme)
const tier = (pct) => (pct == null ? 0 : pct >= 95 ? 3 : pct >= 80 ? 2 : pct >= 60 ? 1 : 0);

function setMeter(id, pct, sub) {
  const el = $(id);
  const known = pct != null && isFinite(pct);
  setText(el.querySelector('.num'), known ? fmtPct(pct) : '—');
  el.querySelector('.unit').style.visibility = known ? 'visible' : 'hidden';
  const w = known ? `${Math.max(0, Math.min(100, pct)).toFixed(1)}%` : '0%';
  const fill = el.querySelector('.fill');
  if (fill.style.width !== w) fill.style.width = w;
  setText(el.querySelector('.meter-sub'), sub);
  el.dataset.level = String(tier(pct));
  el.dataset.known = known ? '1' : '0';
}

function renderLimits(u, t) {
  if (!u) {
    setMeter('m-5h', null, 'aguardando…');
    setMeter('m-7d', null, 'aguardando…');
    return;
  }
  const tot = u.totals || {};
  // 5 horas (some quando a conta não tem essa janela, como no /usage do Claude Code)
  const f = u.fiveHour;
  $('m-5h').hidden = !!f.none;
  let sub5;
  if (f.reset) sub5 = 'reiniciada';
  else if (f.resetsAt) sub5 = `reinicia em ${fmtDuration(f.resetsAt - t)}`;
  else sub5 = f.pct == null ? 'aguardando' : 'sem janela ativa';
  setMeter('m-5h', f.pct, sub5);

  // semanal (todos os modelos) + parcela usada por modelos com limite próprio
  const w = u.sevenDay;
  const models = u.models || [];
  let sub7;
  if (w.reset) sub7 = 'semana reiniciada';
  else if (w.resetsAt) sub7 = `${fmtWhen(w.resetsAt)} · ${fmtDuration(w.resetsAt - t)}`;
  else sub7 = tot.week ? `7d: ${fmtTokens(tot.week.tokens)} tok · ${money(tot.week.cost)}` : 'aguardando';
  setMeter('m-7d', w.pct, sub7);
  const share = models.reduce((a, m) => a + (m.shareOfWeekly || 0), 0);
  const shareEl = $('m-7d').querySelector('.fill-share');
  const shareW = w.pct != null && share > 0 ? `${Math.min(share, w.pct, 100).toFixed(1)}%` : '0%';
  if (shareEl.style.width !== shareW) shareEl.style.width = shareW;
  renderModels(models);

  const pace = weeklyPace(w, models, t);
  const paceEl = $('pace');
  paceEl.hidden = !pace;
  if (pace) {
    setText(paceEl, pace.text);
    paceEl.dataset.level = String(pace.level);
  }

  const src = w.source || f.source;
  let note = '';
  if (src === 'simulação') note = 'SIMULAÇÃO';
  else if (src === 'estimativa') note = w.pct == null ? 'SEM DADOS OFICIAIS' : 'ESTIMADO';
  else if (w.extrapolated) note = '≈ ESTIMADO';
  else if (w.updatedAt) note = `OFICIAL · ${fmtDuration(Date.now() - w.updatedAt)}`;
  setText($('limits-note'), note);
}

// Uma linha por modelo com limite semanal próprio: "FABLE até 50% ▮▮▯▯▯ 12%"
function renderModels(models) {
  const box = $('models');
  const sig = models.map((m) => m.name).join('|');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.textContent = '';
    for (let i = 0; i < models.length; i++) {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML =
        '<span class="mr-label"><span class="mr-name"></span><span class="mr-cap"></span></span>' +
        '<div class="mr-bar"><div class="mr-fill"></div></div><span class="mr-val"></span>';
      box.appendChild(row);
    }
  }
  models.forEach((m, i) => {
    const row = box.children[i];
    setText(row.querySelector('.mr-name'), m.name);
    setText(row.querySelector('.mr-cap'), m.allowance != null ? `até ${Math.round(m.allowance)}% da semana` : 'semanal');
    setText(row.querySelector('.mr-val'), `${fmtPct(m.pct)}%`);
    const fw = `${Math.max(0, Math.min(100, m.pct || 0)).toFixed(1)}%`;
    const fill = row.querySelector('.mr-fill');
    if (fill.style.width !== fw) fill.style.width = fw;
    row.dataset.level = String(tier(m.pct));
  });
}

const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const WEEK_MS = 7 * 864e5;

function resetDayName(ts, t) {
  const d = new Date(ts);
  const a = new Date(t);
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(d) - day0(a)) / 864e5);
  if (diff === 0) return 'de hoje';
  if (diff === 1) return 'de amanhã';
  return `de ${DAY_NAMES[d.getDay()]}`;
}

// Projeção linear: se o ritmo atual continuar, quando cada limite acaba?
function runOutAt(pct, resetsAt, t) {
  if (!pct || pct <= 0 || !resetsAt) return null;
  const start = resetsAt - WEEK_MS;
  if (t <= start) return null;
  const at = start + (t - start) * (100 / pct);
  return at < resetsAt ? at : null;
}

function weeklyPace(w, models, t) {
  if (!w || w.pct == null || !w.resetsAt || w.reset) return null;
  const start = w.resetsAt - WEEK_MS;
  const frac = (t - start) / WEEK_MS;
  if (frac <= 0 || frac > 1) return null;
  const day = resetDayName(w.resetsAt, t);
  if (frac < 0.04) return { level: 0, text: `Semana começando: ${fmtPct(w.pct)}% do limite semanal usado.` };
  let earliest = runOutAt(w.pct, w.resetsAt, t);
  let who = null;
  for (const m of models) {
    const at = runOutAt(m.pct, m.resetsAt || w.resetsAt, t);
    if (at && (!earliest || at < earliest)) {
      earliest = at;
      who = m.name;
    }
  }
  if (earliest) {
    return { level: 2, text: `Acima do ritmo: ${who ? `o limite do ${who}` : 'o limite semanal'} pode acabar ${fmtWhen(earliest)}.` };
  }
  const projected = w.pct / frac;
  if (projected > 85) return { level: 1, text: `Ritmo apertado: deve chegar a ~${Math.round(projected)}% no reset ${day}.` };
  return { level: 0, text: `No ritmo certo. Você deve chegar ao reset ${day} com folga.` };
}

// ---- cartões de sessão
function sessionTexts(x, t) {
  let time = '';
  let act = 'Aguardando comandos';
  if (x.state === 'thinking') {
    time = x.turnStart ? fmtDuration(t - x.turnStart, { seconds: true }) : '';
    act = x.tool ? `${x.tool.icon} ${x.tool.verb} ${x.tool.target}`.trim() : '💭 Pensando…';
  } else if (x.state === 'permission') {
    time = `há ${fmtDuration(t - x.since, { seconds: true })}`;
    act = x.tool && !/pergunta|plano/i.test(x.message || '') ? `✋ ${x.tool.name}: ${x.tool.target}` : `✋ ${x.message || 'Aguardando aprovação'}`;
  } else if (x.state === 'done') {
    const d = x.lastDone || {};
    time = 'agora';
    act = d.error ? '⚠️ Parou com erro da API' : `✅ Concluído${d.duration ? ' em ' + fmtDuration(d.duration, { seconds: true }) : ''}`;
  } else {
    const d = x.lastDone;
    time = d ? `há ${fmtDuration(t - d.at)}` : '';
    if (d) act = `✓ Última tarefa: ${fmtDuration(d.duration || 0, { seconds: true })} · ${d.tools || 0} ferr.`;
  }
  if (x.question && x.state !== 'thinking') act = `❓ ${x.question.text}`;
  let badge = x.state === 'thinking' && !x.tool ? 'PENSANDO' : STATE_BADGE[x.state] || x.state.toUpperCase();
  if (x.question && x.state === 'idle') badge = 'AGUARDANDO VOCÊ';
  return { time, act, badge };
}

function renderSessions(s, p, t) {
  const list = $('session-list');
  const sessions = s ? s.sessions : [];
  const n = sessions.length;
  const busy = sessions.filter((x) => x.state === 'thinking').length;
  const wait = sessions.filter((x) => x.state === 'permission').length;
  const parts = [`${n} ${n === 1 ? 'ATIVA' : 'ATIVAS'}`];
  if (busy) parts.push(`${busy} TRABALHANDO`);
  if (wait) parts.push(`${wait} AGUARDANDO`);
  setText($('sessions-count'), n ? parts.join(' · ') : '');

  const sig = sessions.map((x) => x.id).join('|') || '-empty';
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.textContent = '';
    if (!n) {
      const e = document.createElement('div');
      e.className = 'session-empty';
      e.textContent = s && !s.hooks.count ? 'Nenhuma sessão ainda — rode "npm run setup-hooks" no PC.' : 'Nenhuma sessão do Claude Code aberta.';
      list.appendChild(e);
      return;
    }
    for (let i = 0; i < n; i++) {
      const card = document.createElement('article');
      card.className = 's-card';
      card.innerHTML =
        '<div class="s-head"><span class="s-bot"></span><span class="s-title"><span class="s-name"></span><span class="s-git"></span></span>' +
        '<span class="s-badge"></span><span class="s-time"></span></div>' +
        '<div class="s-act"></div><div class="s-prompt"></div>' +
        '<div class="s-meta"><span class="s-diff"></span><span class="s-sep s-diff-sep">│</span><span class="s-work"></span>' +
        '<span class="s-sep">│</span><span class="s-ctx"><i></i></span><span class="s-ctxv"></span>' +
        '<span class="s-sep">│</span><span class="s-cost"></span><span class="s-sep">│</span><span class="s-model"></span></div>';
      list.appendChild(card);
    }
  }
  if (!n) return;
  sessions.forEach((x, i) => {
    const card = list.children[i];
    const tx = sessionTexts(x, t);
    card.dataset.state = x.state;
    card.dataset.primary = p && x.id === p.id && n > 1 ? '1' : '0';
    setText(card.querySelector('.s-name'), x.name ? `${x.project} · ${x.name}` : x.project);
    // mini-robô na cor do projeto
    const col = colorOf(x);
    const botBox = card.querySelector('.s-bot');
    if (botBox.dataset.color !== col.body) {
      botBox.dataset.color = col.body;
      botBox.textContent = '';
      botBox.appendChild(miniRobot(col));
    }
    // git: branch + PR no título; arquivos e linhas na linha de detalhes
    const g = x.git;
    setText(card.querySelector('.s-git'), g || x.pr ? [g ? `🌿 ${g.branch}` : '', x.pr ? `PR #${x.pr.number}` : ''].filter(Boolean).join(' · ') : '');
    const diff = g ? (g.files ? `±${g.files} arq. +${g.added} −${g.removed}` : 'sem alterações') : '';
    setText(card.querySelector('.s-diff'), diff);
    card.querySelector('.s-diff').hidden = !diff;
    card.querySelector('.s-diff-sep').hidden = !diff;
    setText(card.querySelector('.s-badge'), tx.badge);
    setText(card.querySelector('.s-time'), tx.time);
    setText(card.querySelector('.s-act'), tx.act);
    card.querySelector('.s-act').classList.toggle('q', !!(x.question && x.state !== 'thinking'));
    setText(card.querySelector('.s-prompt'), x.prompt ? `› ${x.prompt}` : '');
    setText(card.querySelector('.s-model'), x.model || 'Claude');
    const wk = x.work && (x.work.project || x.work.session);
    setText(card.querySelector('.s-work'), wk ? `⏱ ${fmtWork(wk.today)} hoje · ${fmtWork(wk.total)} total` : `${x.toolCount || 0} ferr.`);
    const c = x.context && x.context.pct != null ? Math.max(0, Math.min(100, x.context.pct)) : null;
    const bar = card.querySelector('.s-ctx i');
    const bw = `${c == null ? 0 : c.toFixed(1)}%`;
    if (bar.style.width !== bw) bar.style.width = bw;
    setText(card.querySelector('.s-ctxv'), c == null ? 'ctx —' : `ctx ${fmtPct(c)}%`);
    setText(card.querySelector('.s-cost'), x.cost != null ? money(x.cost) : '');
    card.querySelector('.s-cost').title = fxNote();
  });
}

function renderTop() {
  const st = awake.status();
  const a = $('awake');
  a.dataset.on = st.wakeLock || st.video ? '1' : '0';
  a.title = st.wakeLock ? 'Tela sempre ligada (Wake Lock)' : st.video ? 'Tela sempre ligada (vídeo NoSleep)' : 'Tela pode apagar — toque para ativar';
  setText(a, st.wakeLock || st.video ? '💡' : '💤');
  const th = $('theme');
  setText(th, THEME_ICON[theme.pref]);
  th.title = 'Tema: ' + THEME_LABEL[theme.pref] + ' — toque para trocar';
  $('conn').dataset.on = connected ? '1' : '0';
  setText($('mute'), sfx.muted ? '🔇' : '🔊');
  const plan = snap && snap.usage && snap.usage.plan;
  setText($('plan'), plan ? String(plan).toUpperCase() : '');
}

// ---------------------------------------------------------------- controles
function activate() {
  activated = true;
  sfx.unlock();
  awake.enable();
  $('overlay').hidden = true;
  showToast('');
  if (isTouch) {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      // sem travar a orientação: o layout funciona na horizontal e na vertical
      el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
  }
  render();
}

$('overlay').addEventListener('click', activate);
$('awake').addEventListener('click', activate);
let themeToastTimer = 0;
$('theme').addEventListener('click', () => {
  const p = theme.cycle();
  sfx.unlock();
  sfx.play('tick');
  showToast(THEME_ICON[p] + ' Tema ' + THEME_LABEL[p] + (p === 'auto' ? ' (segue o celular)' : ''));
  clearTimeout(themeToastTimer);
  themeToastTimer = setTimeout(() => showToast(''), 2500);
});
$('mute').addEventListener('click', () => {
  sfx.unlock();
  sfx.setMuted(!sfx.muted);
  if (!sfx.muted) sfx.play('tick');
  renderTop();
});
const vol = $('volume');
vol.value = String(Math.round(sfx.volume * 100));
vol.addEventListener('input', () => {
  sfx.unlock();
  sfx.setVolume(Number(vol.value) / 100);
  if (sfx.muted) sfx.setMuted(false);
  renderTop();
});
vol.addEventListener('change', () => sfx.play('tick'));
$('sim-btn').addEventListener('click', () => sim.toggle());
$('full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
});

// dicas no overlay: contexto inseguro (HTTP) e QR code quando aberto no PC
(function overlayTips() {
  if (!window.isSecureContext) $('tip-insecure').hidden = false;
  if (!isTouch) {
    fetch('/api/info')
      .then((r) => r.json())
      .then((info) => {
        if (!info.lan || !info.lan[0]) return;
        $('qr').innerHTML = info.qrSvg || '';
        setText($('qr-url'), info.lan[0].url);
        $('qr-box').hidden = false;
      })
      .catch(() => {});
    fetch('/api/pair/code')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || !j.code) return;
        setText($('pc-code'), j.code);
        $('pc-code-box').hidden = false;
      })
      .catch(() => {});
  }
})();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Voltando de uma atualização automática: pula o overlay e religa a tela acesa na hora.
// Som e tela cheia exigem um toque (regra do Chrome), então mostramos um aviso discreto.
if (session.get('cd.resume', false)) {
  session.set('cd.resume', false);
  activated = true;
  $('overlay').hidden = true;
  awake.enable();
  showToast('✅ Atualizado — toque na tela para reativar o som');
  setTimeout(() => showToast(''), 120e3); // não deixa o aviso parado na tela OLED
  document.addEventListener('pointerdown', () => activate(), { once: true, capture: true });
}

// Modo quiosque (?kiosk na URL): para TVs/monitores sem toque. Pula a tela "toque para ativar" e já
// mantém a tela ligada; o som continua precisando de um toque/clique (regra dos navegadores).
if (new URLSearchParams(location.search).has('kiosk')) {
  $('overlay').hidden = true;
  awake.enable();
  document.addEventListener('pointerdown', () => activate(), { once: true, capture: true });
}

startBurnInShift($('app'));
setInterval(render, 1000);
render();
connect();
