// Vários computadores, uma tela só ("modo satélite").
//
// No computador EXTRA:  npm run link -- <endereço do principal> <código de pareamento>
//   → guarda um token em data/hub.json; ao iniciar, o ClawdDesk desse PC conecta no principal por
//     WebSocket (só saída, pela rede local) e envia as sessões dele, a linha do tempo e os pedidos
//     de aprovação abertos.
// No computador PRINCIPAL (o do celular): nada a configurar. As sessões chegam marcadas com o nome
//   do outro PC; Permitir/Negar no celular volta pelo mesmo WebSocket até o PC de origem.
//
// Segurança: o PC extra só é aceito com um token obtido pelo código de pareamento (o mesmo do
// celular; fica em data/paired.json do principal só como hash). Na rede local trafega direto; com
// um ClawdDesk online (modo servidor), vai por HTTPS/WSS até ele.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import * as cfg from './config.js';

export const HUB_FILE = path.join(cfg.DATA_DIR, 'hub.json');
const STATES = new Set(['idle', 'thinking', 'permission', 'done']);
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// Só os campos que a tela usa, com os tipos certos (o principal não confia cegamente no satélite).
function cleanTool(t) {
  t = obj(t);
  return t ? { icon: str(t.icon, 8) || '', verb: str(t.verb, 60) || '', target: str(t.target, 200) || '', name: str(t.name, 80) || '' } : null;
}
function cleanSession(x) {
  x = obj(x);
  if (!x || typeof x.id !== 'string' || !STATES.has(x.state)) return null;
  const ctx = obj(x.context);
  const g = obj(x.git);
  const w = obj(x.work);
  const ld = obj(x.lastDone);
  const q = obj(x.question);
  const pr = obj(x.pr);
  const period = (p) => (obj(p) ? { today: num(p.today) || 0, total: num(p.total) || 0, sessions: num(p.sessions), first: num(p.first) } : null);
  return {
    id: x.id.slice(0, 80),
    project: str(x.project, 80) || 'Claude Code',
    name: str(x.name, 120),
    state: x.state,
    since: num(x.since) || Date.now(),
    lastEventAt: num(x.lastEventAt) || Date.now(),
    tool: cleanTool(x.tool),
    toolCount: num(x.toolCount) || 0,
    prompt: str(x.prompt, 200),
    message: str(x.message, 200),
    question: q ? { text: str(q.text, 300) || '', options: arr(q.options, 6).map((o) => str(o, 80) || ''), at: num(q.at), source: str(q.source, 20) } : null,
    recent: arr(x.recent, 8)
      .map(obj)
      .filter(Boolean)
      .map((e) => ({ ts: num(e.ts) || 0, icon: str(e.icon, 8) || '·', verb: str(e.verb, 80) || '', target: str(e.target, 160) || '', kind: str(e.kind, 12) || 'tool' })),
    firstSeen: num(x.firstSeen),
    turnStart: num(x.turnStart),
    lastDone: ld ? { at: num(ld.at) || 0, duration: num(ld.duration), tools: num(ld.tools), error: !!ld.error } : null,
    model: str(x.model, 40),
    context: ctx ? { used: num(ctx.used), size: num(ctx.size), pct: num(ctx.pct) } : null,
    cost: num(x.cost),
    tokens: null,
    work: w ? { session: period(w.session), project: period(w.project) } : null,
    git: g ? { branch: str(g.branch, 80) || '?', files: num(g.files), added: num(g.added) || 0, removed: num(g.removed) || 0 } : null,
    pr: pr && num(pr.number) ? { number: num(pr.number) } : null,
  };
}
function cleanApproval(a) {
  a = obj(a);
  if (!a || typeof a.id !== 'string' || typeof a.sessionId !== 'string') return null;
  return {
    id: a.id.slice(0, 40),
    sessionId: a.sessionId.slice(0, 80),
    project: str(a.project, 80) || 'Claude Code',
    tool: cleanTool(a.tool) || { icon: '🔧', verb: '', target: '', name: '?' },
    mode: str(a.mode, 30),
    createdAt: num(a.createdAt) || Date.now(),
    expiresAt: num(a.expiresAt) || Date.now(),
  };
}
// Limites e gastos do PC (usage.view()): só números, booleanos e textos curtos, em poucos níveis.
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function cleanDeep(v, depth = 0) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, 60);
  if (depth >= 4) return null;
  if (Array.isArray(v)) return v.slice(0, 12).map((x) => cleanDeep(x, depth + 1));
  if (typeof v !== 'object') return null;
  const o = {};
  for (const k of Object.keys(v).slice(0, 30)) if (/^[A-Za-z0-9_]{1,30}$/.test(k) && !BAD_KEYS.has(k)) o[k] = cleanDeep(v[k], depth + 1);
  return o;
}
function cleanUsage(u) {
  u = obj(u);
  if (!u) return null;
  const c = cleanDeep(u);
  const win = (w) => (obj(w) ? w : { pct: null, resetsAt: null, source: 'estimativa' });
  const per = (p) => (obj(p) ? { tokens: num(p.tokens) || 0, cost: num(p.cost) || 0 } : { tokens: 0, cost: 0 });
  const t = obj(c.totals) || {};
  return {
    fiveHour: win(c.fiveHour),
    sevenDay: win(c.sevenDay),
    models: arr(c.models, 8).filter((m) => obj(m) && typeof m.name === 'string'),
    plan: str(c.plan, 40),
    oauth: str(c.oauth, 30),
    calibration: obj(c.calibration),
    totals: { today: per(t.today), week: per(t.week), block: obj(t.block) },
    scanReady: !!c.scanReady,
  };
}

function cleanTimeline(t) {
  t = obj(t);
  if (!t) return null;
  return {
    projects: arr(t.projects, 30)
      .map(obj)
      .filter((p) => p && typeof p.name === 'string')
      .map((p) => ({
        key: str(p.key, 200) || p.name,
        name: p.name.slice(0, 80),
        total: num(p.total) || 0,
        intervals: arr(p.intervals, 400).filter((iv) => Array.isArray(iv) && num(iv[0]) != null && num(iv[1]) != null).map((iv) => [iv[0], iv[1]]),
      })),
  };
}

// ---------------------------------------------------------------- lado do PRINCIPAL
export class SatelliteHub extends EventEmitter {
  constructor(approvals) {
    super();
    this.approvals = approvals;
    this.sats = new Map(); // id -> { id, host, ws, online, at, sessions, timeline, approvals, bridgeIds }
    this.acks = new Map(); // reqId -> { resolve, timer }
  }

  hello(ws, msg) {
    const dev = this.approvals.verify(msg.token);
    if (!dev) {
      try {
        ws.send(JSON.stringify({ type: 'satellite-denied' }));
        ws.close();
      } catch {
        /* já fechou */
      }
      this.emit('log', `🖥  Conexão de outro PC recusada (${ws.info.ip}): pareamento inválido — rode "npm run link" de novo nele`);
      return;
    }
    const id = dev.hash.slice(0, 12);
    ws.sat = { id };
    const prev = this.sats.get(id);
    if (prev && prev.ws && prev.ws !== ws) {
      try {
        prev.ws.close();
      } catch {
        /* ignore */
      }
    }
    if (prev) clearTimeout(prev.dropTimer);
    const host = str(msg.host, 32) || dev.label;
    this.sats.set(id, {
      sessions: [],
      timeline: null,
      approvals: [],
      bridgeIds: [],
      ...prev,
      id,
      host,
      ws,
      online: true,
      at: Date.now(),
      dropTimer: null,
    });
    ws.send(JSON.stringify({ type: 'satellite-ok', hub: cfg.MACHINE_NAME }));
    if (!prev || !prev.online) this.emit('log', `🖥  ${host} conectado (${ws.info.ip}) — as sessões dele aparecem aqui`);
    this.emit('change');
  }

  state(ws, msg) {
    const s = ws.sat && this.sats.get(ws.sat.id);
    if (!s || s.ws !== ws) return;
    s.sessions = arr(msg.sessions, 12).map(cleanSession).filter(Boolean);
    s.timeline = cleanTimeline(msg.timeline);
    s.approvals = arr(msg.approvals, 10).map(cleanApproval).filter(Boolean);
    s.bridgeIds = arr(msg.bridgeIds, 500).filter((x) => typeof x === 'string').map((x) => x.slice(0, 80));
    if (msg.usage) {
      s.usage = cleanUsage(msg.usage);
      s.usageAt = Date.now();
    }
    s.at = Date.now();
    this.emit('change');
  }

  closed(ws) {
    const s = ws.sat && this.sats.get(ws.sat.id);
    if (!s || s.ws !== ws) return;
    s.ws = null;
    s.online = false;
    s.approvals = [];
    this.emit('log', `🖥  ${s.host} desconectado`);
    // some da tela depois de 2 min sem voltar (queda rápida de Wi-Fi não apaga nada)
    s.dropTimer = setTimeout(() => {
      this.sats.delete(s.id);
      this.emit('change');
    }, 120e3);
    s.dropTimer.unref();
    this.emit('change');
  }

  // aparelho removido na tela: derruba a conexão do PC e tira as sessões dele
  drop(id) {
    const s = this.sats.get(id);
    if (!s) return;
    clearTimeout(s.dropTimer);
    this.sats.delete(id);
    if (s.ws) {
      try {
        s.ws.send(JSON.stringify({ type: 'satellite-denied' }));
        s.ws.close();
      } catch {
        /* já fechou */
      }
    }
    this.emit('log', `🖥  ${s.host} removido`);
    this.emit('change');
  }

  // Modo servidor: os limites da conta vêm dos PCs. Vale a leitura oficial mais recente; os gastos
  // de hoje e da semana somam todos os PCs.
  usage() {
    const now = Date.now();
    const list = [...this.sats.values()].filter((s) => s.usage && now - s.usageAt < 30 * 60e3);
    if (!list.length) return null;
    const official = (u) => (u.sevenDay.source && u.sevenDay.source !== 'estimativa') || (u.fiveHour.source && u.fiveHour.source !== 'estimativa');
    const fresh = (u) => Math.max(num(u.sevenDay.updatedAt) || 0, num(u.fiveHour.updatedAt) || 0);
    list.sort((a, b) => official(b.usage) - official(a.usage) || fresh(b.usage) - fresh(a.usage) || b.usageAt - a.usageAt);
    const best = list[0].usage;
    const sum = (k) => list.reduce((acc, s) => ({ tokens: acc.tokens + s.usage.totals[k].tokens, cost: acc.cost + s.usage.totals[k].cost }), { tokens: 0, cost: 0 });
    return { ...best, totals: { ...best.totals, today: sum('today'), week: sum('week') }, from: list[0].host };
  }

  result(msg) {
    const p = this.acks.get(msg.reqId);
    if (!p) return;
    this.acks.delete(msg.reqId);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  // Permitir/Negar vindo do celular para um pedido de outro PC (id "sat:<pc>:<pedido>")
  async decide(fullId, decision) {
    const [, satId, ...rest] = fullId.split(':');
    const id = rest.join(':');
    const s = this.sats.get(satId);
    if (!s || !s.ws || s.ws.readyState !== 1) return { ok: false, status: 410, error: 'o outro PC desconectou — responda nele' };
    const item = s.approvals.find((a) => a.id === id);
    const reqId = crypto.randomBytes(6).toString('hex');
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(reqId);
        resolve({ ok: false, status: 504, error: 'o outro PC não respondeu — responda nele' });
      }, 5000);
      this.acks.set(reqId, { resolve, timer });
      s.ws.send(JSON.stringify({ type: 'decision', reqId, id, decision }));
    });
    if (reply.ok) {
      s.approvals = s.approvals.filter((a) => a.id !== id);
      this.emit('change');
    }
    return { ok: !!reply.ok, status: reply.ok ? 200 : reply.status || 410, error: reply.error, host: s.host, item };
  }

  // avisa os satélites se há celular pareado olhando (para eles esperarem a resposta do celular)
  broadcastStatus(phonesOnline) {
    const msg = JSON.stringify({ type: 'hub-status', phonesOnline: !!phonesOnline });
    for (const s of this.sats.values()) if (s.ws && s.ws.readyState === 1) s.ws.send(msg);
  }

  sessions() {
    const out = [];
    for (const s of this.sats.values()) {
      for (const x of s.sessions) {
        const v = { ...x, id: `sat:${s.id}:${x.id}`, origin: { kind: 'pc', label: s.host, online: s.online } };
        if (!s.online) {
          // PC desligado/sem rede: mostra como parado, sem alertas
          v.state = 'idle';
          v.message = `${s.host} desconectado`;
        }
        out.push(v);
      }
    }
    return out;
  }

  approvalsView() {
    const out = [];
    for (const s of this.sats.values()) {
      if (!s.online) continue;
      for (const a of s.approvals) out.push({ ...a, id: `sat:${s.id}:${a.id}`, sessionId: `sat:${s.id}:${a.sessionId}`, host: s.host });
    }
    return out;
  }

  timelineProjects() {
    const out = [];
    for (const s of this.sats.values()) if (s.timeline) for (const p of s.timeline.projects) out.push({ ...p, key: `sat:${s.id}:${p.key}`, host: s.host });
    return out;
  }

  bridgeIds() {
    const set = new Set();
    for (const s of this.sats.values()) for (const b of s.bridgeIds) set.add(b);
    return set;
  }

  view() {
    return [...this.sats.values()].map((s) => ({ id: s.id, host: s.host, online: s.online, sessions: s.sessions.length, at: s.at }));
  }
}

// ---------------------------------------------------------------- lado do computador EXTRA
export function readHubConfig() {
  try {
    const o = JSON.parse(fs.readFileSync(HUB_FILE, 'utf8'));
    if (o && typeof o.url === 'string' && typeof o.token === 'string') return o;
  } catch {
    /* sem vínculo */
  }
  return null;
}

export class SatelliteLink extends EventEmitter {
  constructor({ snapshotPart, onDecision }) {
    super();
    this.conf = readHubConfig();
    this.snapshotPart = snapshotPart; // () => { sessions, timeline, approvals, bridgeIds }
    this.onDecision = onDecision; // (id, decision) => { ok, status, error }
    this.ws = null;
    this.linked = false;
    this.phonesOnline = false;
    this.hubName = null;
    this.retry = 2000;
    this.stopped = false;
    this.pushTimer = null;
    this.lastLog = '';
  }

  get enabled() {
    return !!this.conf;
  }

  log(s) {
    if (s === this.lastLog) return;
    this.lastLog = s;
    this.emit('log', s);
  }

  start() {
    if (!this.conf) return;
    this.connect();
    setInterval(() => this.push(true), 15e3).unref();
  }

  connect() {
    if (this.stopped) return;
    const url = this.conf.url.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';
    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 8000 });
    } catch {
      return this.reconnect();
    }
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'satellite-hello', token: this.conf.token, host: cfg.MACHINE_NAME, version: 1 }));
    });
    ws.on('message', (m) => {
      let msg;
      try {
        msg = JSON.parse(String(m));
      } catch {
        return;
      }
      if (msg.type === 'satellite-ok') {
        this.linked = true;
        this.retry = 2000;
        this.hubName = str(msg.hub, 40);
        this.log(`🛰  Enviando as sessões deste PC para o ClawdDesk principal${this.hubName ? ` (${this.hubName})` : ''} em ${this.conf.url}`);
        this.emit('change');
        this.push(true);
      } else if (msg.type === 'satellite-denied') {
        this.stopped = true;
        this.log('✖  O ClawdDesk principal recusou este PC (pareamento removido). Rode "npm run link" de novo.');
        ws.close();
      } else if (msg.type === 'hub-status') {
        this.phonesOnline = !!msg.phonesOnline;
      } else if (msg.type === 'decision' && typeof msg.id === 'string') {
        let r;
        try {
          r = this.onDecision(msg.id, msg.decision === 'allow' ? 'allow' : 'deny');
        } catch (e) {
          r = { ok: false, status: 500, error: e.message };
        }
        ws.send(JSON.stringify({ type: 'decision-result', reqId: msg.reqId, ...r }));
      }
    });
    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.linked;
      this.linked = false;
      this.phonesOnline = false;
      if (this.stopped) return this.emit('change'); // recusado pelo principal: já avisou, não tenta de novo
      const where = /^https:/i.test(this.conf.url) ? 'ele está no ar e o endereço está certo?' : 'ele está aberto e no mesmo Wi-Fi?';
      if (was) this.log(`⚠  Conexão com o ClawdDesk principal caiu (${this.conf.url}) — tentando de novo…`);
      else this.log(`⚠  Não consegui falar com o ClawdDesk principal em ${this.conf.url} — ${where} Tentando de novo…`);
      this.emit('change');
      this.reconnect();
    };
    ws.on('close', down);
    ws.on('error', down);
  }

  reconnect() {
    if (this.stopped) return;
    setTimeout(() => this.connect(), this.retry).unref();
    this.retry = Math.min(this.retry * 2, 30e3);
  }

  // envia o estado deste PC (no máximo 1x por segundo)
  push(now = false) {
    if (!this.linked || !this.ws || this.ws.readyState !== 1) return;
    if (this.pushTimer && !now) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(
      () => {
        this.pushTimer = null;
        if (!this.ws || this.ws.readyState !== 1) return;
        try {
          this.ws.send(JSON.stringify({ type: 'satellite-state', ...this.snapshotPart() }));
        } catch {
          /* conexão caiu no meio: o "close" cuida */
        }
      },
      now ? 0 : 1000
    );
  }

  view() {
    return this.conf ? { url: this.conf.url, linked: this.linked, hub: this.hubName } : null;
  }
}
