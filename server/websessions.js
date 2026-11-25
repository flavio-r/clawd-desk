// Sessões do Claude Code fora deste computador, vistas pela sua conta no claude.ai:
//   ☁ web     → sessões na nuvem (claude.ai/code, app do celular, "nova sessão na nuvem" do app desktop)
//   📡 remoto → sessões de OUTROS computadores com Controle Remoto ligado
//
// Fonte: GET https://api.anthropic.com/v1/code/sessions — a mesma lista que o próprio Claude Code
// usa (ex.: "claude --teleport"). Usa o token OAuth já lido pelo UsageTracker (Keychain), só para
// leitura, e nunca o envia ao celular. O endpoint não é documentado oficialmente e pode mudar: se
// falhar, o monitor só deixa de mostrar essas sessões.
//
// Sessões deste PC que também aparecem no claude.ai (Controle Remoto, app desktop) são ignoradas
// aqui: elas já aparecem como sessões locais, com muito mais detalhe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as cfg from './config.js';
import { prettyModel } from './pricing.js';
import { bridgeKey } from './localsessions.js';

const LIST_URL = 'https://api.anthropic.com/v1/code/sessions?limit=50';
const DONE_HOLD_MS = 12e3; // igual às sessões locais: "concluído" fica 12 s na tela
const MAX_SHOWN = 8;
const HUSK = (t) => !t || t.includes('__CBU_POOLED__') || t === '__warming__' || t.startsWith('ditto:');
const str = (v, n = 160) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

function orgUuid() {
  // ~/.claude.json (ou $CLAUDE_CONFIG_DIR/.claude.json) guarda a organização da conta logada
  const files = process.env.CLAUDE_CONFIG_DIR
    ? [path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')]
    : [path.join(os.homedir(), '.claude.json'), path.join(cfg.CLAUDE_DIR, '.claude.json')];
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (o.oauthAccount && o.oauthAccount.organizationUuid) return String(o.oauthAccount.organizationUuid);
    } catch {
      /* próximo */
    }
  }
  return null;
}

// Mesma leitura de estado que o Claude Code faz para sessões remotas.
function stateOf(x) {
  const pts = (x.external_metadata && x.external_metadata.post_turn_summary) || {};
  const waiting = { state: 'permission', why: str(pts.needs_action) || 'Aguardando você no claude.ai' };
  if (x.worker_status === 'requires_action') return waiting;
  if (x.worker_status === 'idle' || x.status === 'paused') {
    if (x.status_bucket === 'blocked') return waiting;
    if (x.status_bucket === 'failed') return { state: 'idle', failed: true, why: str(pts.status_detail) || 'a última tarefa falhou' };
    if (x.status_bucket === 'working') return { state: 'thinking' };
    return { state: 'idle' };
  }
  if (x.worker_status === 'running' && x.connection_status === 'disconnected') return { state: 'idle', why: 'perdeu contato com a sessão' };
  return { state: 'thinking' };
}

function projectOf(x) {
  const c = x.config || {};
  for (const o of c.outcomes || []) {
    const repo = o && o.git_info && o.git_info.repo;
    if (repo) return String(repo).split('/').pop();
  }
  const br = x.external_metadata && x.external_metadata.current_branches;
  const key = br && Object.keys(br).find(Boolean);
  return key ? key.split('/').pop() : null;
}

export class WebSessions extends EventEmitter {
  constructor(usage, getExcluded) {
    super();
    this.usage = usage; // fornece o token OAuth (usage.oauth.token)
    this.getExcluded = getExcluded; // () => Set de ids (sem prefixo) que já aparecem como sessões locais/satélites
    this.status = cfg.WEB_ENABLED ? 'aguardando-login' : 'desativado';
    this.raw = []; // última lista recebida (já filtrada de arquivadas)
    this.track = new Map(); // id -> { state, since, doneAt, failed }
    this.lastAt = 0;
    this.nextAt = 0;
    this.backoff = cfg.WEB_POLL_MS;
    this.inflight = false;
    this.org = null;
    this.isWatched = () => true; // trocado pelo index.js: há alguém olhando a tela?
  }

  start() {
    if (!cfg.WEB_ENABLED) return;
    this.org = orgUuid();
    const loop = () => {
      if (Date.now() >= this.nextAt) this.poll();
    };
    setTimeout(loop, 3000).unref();
    setInterval(loop, 5000).unref();
  }

  setStatus(st) {
    if (st === this.status) return;
    const before = this.status;
    this.status = st;
    this.emit('status', st, before);
  }

  async poll() {
    if (this.inflight) return;
    const token = this.usage.oauth && this.usage.oauth.status === 'ok' ? this.usage.oauth.token : null;
    const now = Date.now();
    if (!token) {
      this.setStatus('aguardando-login');
      this.nextAt = now + 15e3;
      return;
    }
    // ninguém olhando: consulta bem menos
    const every = this.isWatched() ? cfg.WEB_POLL_MS : 5 * 60e3;
    this.inflight = true;
    try {
      const headers = {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
        'User-Agent': 'clawddesk/1.0',
      };
      if (this.org) headers['x-organization-uuid'] = this.org;
      const res = await fetch(LIST_URL, { headers, signal: AbortSignal.timeout(15e3) });
      if (res.status === 401 || res.status === 403) {
        this.setStatus(res.status === 401 ? 'nao-autorizado' : 'sem-acesso');
        this.nextAt = now + 5 * 60e3;
        return;
      }
      if (res.status === 429) {
        this.backoff = Math.min(this.backoff * 2, 15 * 60e3);
        this.setStatus('limitado');
        this.nextAt = now + this.backoff;
        return;
      }
      if (!res.ok) {
        this.setStatus(`http-${res.status}`);
        this.nextAt = now + 5 * 60e3;
        return;
      }
      const j = await res.json();
      const list = Array.isArray(j && j.data) ? j.data : [];
      this.raw = list.filter((x) => x && /^(session|cse)_/.test(String(x.id)) && x.status !== 'archived' && !HUSK(str(x.title, 200)));
      this.backoff = cfg.WEB_POLL_MS;
      this.lastAt = Date.now();
      this.nextAt = this.lastAt + every;
      this.setStatus('ok');
      this.updateTrack();
      this.emit('change');
    } catch {
      this.setStatus('erro');
      this.nextAt = Date.now() + 2 * 60e3;
    } finally {
      this.inflight = false;
    }
  }

  // Acompanha as mudanças de estado entre consultas para avisar "concluído" no celular.
  updateTrack() {
    const now = Date.now();
    const seen = new Set();
    for (const x of this.raw) {
      seen.add(x.id);
      const st = stateOf(x);
      const t = this.track.get(x.id);
      if (!t) {
        // primeira vez que vemos: sem alerta, "desde" = último evento
        this.track.set(x.id, { state: st.state, since: Date.parse(x.last_event_at || x.created_at) || now, doneAt: 0, failed: !!st.failed });
        continue;
      }
      if (t.state !== st.state) {
        if (t.state === 'thinking' && st.state === 'idle') {
          t.doneAt = now; // terminou entre uma consulta e outra
          t.failed = !!st.failed;
          setTimeout(() => this.emit('change'), DONE_HOLD_MS + 500).unref();
        }
        t.state = st.state;
        t.since = now;
      }
    }
    for (const id of this.track.keys()) if (!seen.has(id)) this.track.delete(id);
  }

  // Separa as sessões da conta: as que aparecem na tela (ativas ou recentes) e quantas ficaram de
  // fora por serem antigas. As deste PC e dos satélites nem entram na conta.
  pick() {
    const now = Date.now();
    const excluded = this.getExcluded();
    const shown = [];
    let old = 0;
    for (const x of this.raw) {
      if (excluded.has(bridgeKey(x.id))) continue; // é uma sessão deste PC (ou de um satélite)
      const st = stateOf(x);
      const last = Date.parse(x.last_event_at || x.updated_at || x.created_at) || 0;
      const active = st.state === 'thinking' || st.state === 'permission';
      if (!active && now - last > cfg.WEB_RECENT_MS) old++;
      else shown.push({ x, st, last });
    }
    shown.sort((a, b) => b.last - a.last);
    return { shown: shown.slice(0, MAX_SHOWN), old: old + Math.max(0, shown.length - MAX_SHOWN) };
  }

  view() {
    const now = Date.now();
    const out = [];
    for (const { x, st, last } of this.pick().shown) {
      const t = this.track.get(x.id) || { since: now, doneAt: 0 };
      const em = x.external_metadata || {};
      const pts = em.post_turn_summary || {};
      const remote = x.environment_kind === 'bridge';
      const title = str(x.title, 80);
      const repo = projectOf(x);
      const done = t.doneAt && now - t.doneAt < DONE_HOLD_MS;
      const state = done ? 'done' : st.state;
      const ctx = em.context_usage;
      const branches = em.current_branches && Object.values(em.current_branches).filter(Boolean);
      const endedAt = em.turn && Number(em.turn.ended_at);
      const recentAction = str(pts.recent_action, 140);
      out.push({
        id: `web:${x.id}`,
        origin: remote
          ? { kind: 'remote', label: 'outro PC', online: x.connection_status === 'connected' }
          : { kind: 'web', label: 'web' },
        url: `https://claude.ai/code/${x.id}`,
        project: repo || title || 'claude.ai',
        name: repo ? title : null,
        state,
        since: done ? t.doneAt : t.since,
        lastEventAt: last,
        tool: null,
        toolCount: 0,
        prompt: null,
        message: st.why || str(x.status_line, 120) || str(pts.status_detail, 120) || null,
        question: null,
        recent: recentAction ? [{ ts: endedAt || last, icon: remote ? '📡' : '☁', verb: recentAction, target: '', kind: st.failed ? 'error' : 'done' }] : [],
        firstSeen: Date.parse(x.created_at) || last,
        turnStart: st.state === 'thinking' ? t.since : null,
        lastDone: endedAt ? { at: endedAt, duration: null, tools: null, error: done ? t.failed : !!st.failed } : null,
        model: prettyModel(em.model || em.last_served_model || (x.config && x.config.model)) || null,
        context:
          ctx && ctx.max_tokens
            ? { used: ctx.used_tokens || 0, size: ctx.max_tokens, pct: ((ctx.used_tokens || 0) / ctx.max_tokens) * 100 }
            : null,
        cost: em.usage && typeof em.usage.cost_usd === 'number' ? em.usage.cost_usd : null,
        tokens: null,
        work: null,
        git: branches && branches.length ? { branch: String(branches[0]), files: null } : null,
        pr: null,
        unread: !!x.unread,
      });
    }
    return out; // pick() já ordenou e limitou
  }

  // Para a linha "de onde vêm as sessões": quantas aparecem de cada tipo e quantas antigas ficaram de fora
  info() {
    const base = { status: this.status, lastAt: this.lastAt, recentH: Math.round(cfg.WEB_RECENT_MS / 3600e3) };
    if (this.status !== 'ok') return base;
    const { shown, old } = this.pick();
    const remote = shown.filter((s) => s.x.environment_kind === 'bridge').length;
    return { ...base, web: shown.length - remote, remote, old };
  }
}
