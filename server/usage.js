// Uso e limites: combina três fontes, da mais confiável para a menos:
//  1) statusLine do Claude Code (campo rate_limits: five_hour / seven_day) — empurrado a cada resposta;
//  2) API OAuth do Claude.ai (/api/oauth/usage) — consultada a cada ~2 min;
//  3) estimativa pelos logs locais ~/.claude/projects/**/*.jsonl (tokens, custo, bloco de 5h).
// Os logs também dão, por sessão, o uso de contexto e o custo estimado.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as cfg from './config.js';
import { costFor, contextWindowFor } from './pricing.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEEP_MS = 8 * DAY;
const USAGE_BYTES = Buffer.from('"usage":');
const TYPE_USER = Buffer.from('"type":"user"');
const TOOL_USE_ID = Buffer.from('"tool_use_id"');
const PR_LINK = Buffer.from('{"type":"pr-link"');
const KEEP_INTERVALS_MS = 2 * DAY;
const MAX_TURN_MS = 4 * HOUR; // um turno "esquecido" aberto não infla o total

// dia local "AAAA-MM-DD" (os totais de "hoje" seguem o relógio do PC)
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CAL_FILE = path.join(cfg.DATA_DIR, 'calibration.json');
const SPAN = { five_hour: 5 * HOUR, seven_day: 7 * DAY };
const CAL_KEY = { five_hour: 'fiveHourUsd', seven_day: 'sevenDayUsd' };

export class UsageTracker extends EventEmitter {
  constructor() {
    super();
    this.windows = { five_hour: null, seven_day: null }; // { pct, resetsAt(ms), source, updatedAt }
    this.models = { list: [], updatedAt: 0 }; // limites semanais por modelo (ex.: Fable), via OAuth
    this.plan = null;
    this.oauth = {
      status: cfg.OAUTH_ENABLED ? 'pending' : 'disabled',
      nextAt: 0,
      lastAt: 0,
      backoff: cfg.OAUTH_POLL_MS,
      inflight: false,
      token: null,
      tokenExp: 0,
    };
    this.files = new Map(); // caminho -> { offset, rest: Buffer }
    this.entries = []; // { ts, tokens, cost, key }
    this.seen = new Set();
    this.sessions = new Map(); // sessionId -> métricas agregadas
    this.scanReady = false;
    this.scanning = false;
    this.fileTimers = new Map();
    this.blockCache = null;
    // tempo trabalhado: por sessão, somando turnos (pedido → última resposta do Claude)
    this.work = new Map(); // sessionId -> { project, file, days: Map(dia -> ms), turnStart, turnEnd, first }
    this.fullScanned = new Set(); // projetos cujos logs antigos já foram lidos
    this.prs = new Map(); // sessionId -> { number, url, repo, at }
    this.timelineCache = null;
    this.projectCache = new Map();
    this.calAt = {};
    this.cal = {};
    try {
      this.cal = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')) || {};
    } catch {
      this.cal = {};
    }
  }

  start() {
    this.scanAll();
    setInterval(() => this.scanAll(), 60e3).unref();
    if (cfg.OAUTH_ENABLED) {
      this.pollOAuth();
      setInterval(() => {
        if (Date.now() >= this.oauth.nextAt) this.pollOAuth();
      }, 10e3).unref();
    }
  }

  // ---------- 1) statusLine ----------
  applyStatusline(rl) {
    if (!rl || typeof rl !== 'object') return false;
    let changed = false;
    for (const key of ['five_hour', 'seven_day']) {
      const w = rl[key];
      if (w && typeof w.used_percentage === 'number') {
        this.windows[key] = {
          pct: w.used_percentage,
          resetsAt: w.resets_at ? Number(w.resets_at) * 1000 : null,
          source: 'statusline',
          updatedAt: Date.now(),
        };
        this.calibrate(key);
        changed = true;
      }
    }
    if (changed) this.emit('change');
    return changed;
  }

  // ---------- 2) OAuth ----------
  requestOAuthSoon() {
    if (!cfg.OAUTH_ENABLED) return;
    // depois de um "Stop" vale atualizar, mas sem martelar a API (mín. 60 s entre consultas)
    const earliest = Math.max(this.oauth.lastAt + 60e3, Date.now() + 4e3);
    if (earliest < this.oauth.nextAt) this.oauth.nextAt = earliest;
  }

  async readCredentials() {
    let raw = null;
    if (process.platform === 'darwin') {
      raw = await new Promise((resolve) => {
        execFile(
          'security',
          ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          { timeout: 5000 },
          (err, stdout) => resolve(err ? null : String(stdout).trim())
        );
      });
    }
    if (!raw) {
      try {
        raw = await fsp.readFile(path.join(cfg.CLAUDE_DIR, '.credentials.json'), 'utf8');
      } catch {
        raw = null;
      }
    }
    if (!raw) return null;
    try {
      const o = JSON.parse(raw).claudeAiOauth;
      if (!o || !o.accessToken) return null;
      if (o.subscriptionType) this.plan = o.subscriptionType;
      return { accessToken: o.accessToken, expiresAt: Number(o.expiresAt) || 0 };
    } catch {
      return null;
    }
  }

  async pollOAuth() {
    const o = this.oauth;
    if (o.inflight) return;
    o.inflight = true;
    const now = Date.now();
    try {
      if (!o.token || (o.tokenExp && o.tokenExp < now + MIN)) {
        const cred = await this.readCredentials();
        o.token = cred ? cred.accessToken : null;
        o.tokenExp = cred ? cred.expiresAt : 0;
      }
      if (!o.token) {
        o.status = 'sem-credenciais';
        o.nextAt = now + MIN; // tenta de novo logo: o usuário pode estar fazendo /login agora
        return;
      }
      if (o.tokenExp && o.tokenExp < now + 30e3) {
        // Nunca renovamos o token por conta própria (isso poderia deslogar o Claude Code).
        o.status = 'token-expirado';
        o.token = null;
        o.nextAt = now + MIN;
        return;
      }
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${o.token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
          'User-Agent': 'clawddesk/1.0',
        },
        signal: AbortSignal.timeout(10e3),
      });
      if (res.status === 401 || res.status === 403) {
        o.status = 'nao-autorizado';
        o.token = null;
        o.nextAt = now + 5 * MIN;
        return;
      }
      if (res.status === 429) {
        o.backoff = Math.min(o.backoff * 2, 15 * MIN);
        o.status = 'limitado';
        o.nextAt = now + o.backoff;
        return;
      }
      if (!res.ok) {
        o.status = `http-${res.status}`;
        o.nextAt = now + 5 * MIN;
        return;
      }
      const j = await res.json();
      this.applyUsageResponse(j);
      o.status = 'ok';
      o.backoff = cfg.OAUTH_POLL_MS;
      o.lastAt = Date.now();
      o.nextAt = o.lastAt + cfg.OAUTH_POLL_MS;
      this.emit('change');
    } catch (e) {
      o.status = 'erro';
      o.nextAt = Date.now() + 5 * MIN;
    } finally {
      o.inflight = false;
    }
  }

  // Interpreta a resposta de /api/oauth/usage (mesmo formato usado pelo app Claude):
  //  five_hour / seven_day           → { utilization, resets_at }
  //  limits[]                        → { kind: 'weekly_all' | 'weekly_scoped' | …, percent, resets_at,
  //                                      scope: { model: { display_name: 'Fable' } } }
  //  weekly_scoped_shares[]          → { limit_index, used_percent_of_weekly, allowance_percent_of_weekly }
  //                                      ("Até 50% do seu limite semanal")
  applyUsageResponse(j) {
    if (!j || typeof j !== 'object') return;
    const now = Date.now();
    const limits = Array.isArray(j.limits) ? j.limits : [];
    const shares = Array.isArray(j.weekly_scoped_shares) ? j.weekly_scoped_shares : [];
    const weeklyAll = limits.find((l) => l && l.kind === 'weekly_all' && typeof l.percent === 'number');
    const src = {
      five_hour: j.five_hour,
      seven_day: j.seven_day || (weeklyAll ? { utilization: weeklyAll.percent, resets_at: weeklyAll.resets_at } : null),
    };
    for (const key of ['five_hour', 'seven_day']) {
      const w = src[key];
      if (w && typeof w.utilization === 'number') {
        this.windows[key] = {
          pct: w.utilization,
          resetsAt: w.resets_at ? Date.parse(w.resets_at) || null : null,
          source: 'oauth',
          updatedAt: now,
        };
        this.calibrate(key);
      }
    }
    // five_hour === null: a conta não tem janela de 5h ativa (o /usage do Claude Code esconde a barra)
    this.fiveHourNone = j.five_hour === null ? now : 0;
    if (this.fiveHourNone && this.windows.five_hour && this.windows.five_hour.source === 'oauth') this.windows.five_hour = null;
    const models = [];
    limits.forEach((l, idx) => {
      if (!l || l.kind !== 'weekly_scoped' || typeof l.percent !== 'number') return;
      const name = l.scope && l.scope.model && String(l.scope.model.display_name || '').trim();
      if (!name) return;
      const sh = shares.find((x) => x && x.limit_index === idx);
      models.push({
        name,
        pct: l.percent,
        resetsAt: l.resets_at ? Date.parse(l.resets_at) || null : null,
        allowance: sh && typeof sh.allowance_percent_of_weekly === 'number' ? sh.allowance_percent_of_weekly : null,
        shareOfWeekly: sh && typeof sh.used_percent_of_weekly === 'number' ? sh.used_percent_of_weekly : null,
        severity: l.severity || null,
      });
    });
    // formato antigo (contas sem "limits"): Opus/Sonnet semanais
    for (const [k, name] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]) {
      const w = j[k];
      if (w && typeof w.utilization === 'number' && !models.some((m) => m.name.toLowerCase().startsWith(name.toLowerCase()))) {
        models.push({ name, pct: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) || null : null, allowance: null, shareOfWeekly: null });
      }
    }
    this.models = { list: models, updatedAt: now };
    // guarda a última resposta (só números e datas, sem credenciais) para diagnóstico
    try {
      fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(cfg.DATA_DIR, 'usage-last.json'), JSON.stringify({ fetchedAt: new Date(now).toISOString(), response: j }, null, 2));
    } catch {
      /* opcional */
    }
    this.emit('change');
  }

  modelsView() {
    const now = Date.now();
    if (!this.models.list.length || now - this.models.updatedAt > 7 * DAY) return [];
    return this.models.list.map((m) =>
      m.resetsAt && m.resetsAt <= now ? { ...m, pct: 0, shareOfWeekly: 0, resetsAt: null, reset: true } : { ...m, updatedAt: this.models.updatedAt }
    );
  }

  // ---------- 3) logs JSONL ----------
  async scanAll() {
    if (this.scanning) return;
    this.scanning = true;
    const t0 = Date.now();
    try {
      const cutoff = Date.now() - KEEP_MS;
      const files = await listJsonl(cfg.PROJECTS_DIR, 5);
      let touched = false;
      for (const f of files) {
        let st;
        try {
          st = await fsp.stat(f);
        } catch {
          continue;
        }
        if (st.mtimeMs < cutoff) continue;
        if (await this.scanFile(f, st.size)) touched = true;
      }
      this.prune();
      const first = !this.scanReady;
      this.scanReady = true;
      if (first && !cfg.QUIET) {
        console.log(
          `  📊 Logs locais indexados: ${this.files.size} arquivos, ${this.entries.length} respostas (${((Date.now() - t0) / 1000).toFixed(1)} s)`
        );
      }
      if (touched || first) this.emit('change');
    } catch (e) {
      if (!cfg.QUIET) console.error('  ⚠ Falha ao ler logs:', e.message);
    } finally {
      this.scanning = false;
    }
  }

  // Releitura rápida de um único transcript (chamada pelos hooks).
  refreshFile(file) {
    if (!file || !file.endsWith('.jsonl')) return;
    clearTimeout(this.fileTimers.get(file));
    this.fileTimers.set(
      file,
      setTimeout(async () => {
        this.fileTimers.delete(file);
        try {
          const st = await fsp.stat(file);
          if (await this.scanFile(file, st.size)) this.emit('change');
        } catch {
          /* arquivo ainda não existe */
        }
      }, 1200)
    );
  }

  async scanFile(file, size) {
    let rec = this.files.get(file);
    if (!rec) {
      rec = { offset: 0, rest: Buffer.alloc(0) };
      this.files.set(file, rec);
    }
    if (size < rec.offset) {
      for (const [sid, w] of this.work) if (w.file === file) this.work.delete(sid);
      rec.offset = 0;
      rec.rest = Buffer.alloc(0);
    }
    if (size === rec.offset) return false;
    await new Promise((resolve) => {
      const stream = fs.createReadStream(file, { start: rec.offset, end: size - 1, highWaterMark: 1 << 20 });
      stream.on('data', (chunk) => {
        const buf = rec.rest.length ? Buffer.concat([rec.rest, chunk]) : chunk;
        let start = 0;
        let nextUsage = buf.indexOf(USAGE_BYTES, 0);
        let idx;
        while ((idx = buf.indexOf(10, start)) !== -1) {
          if (nextUsage !== -1 && nextUsage < start) nextUsage = buf.indexOf(USAGE_BYTES, start);
          if (nextUsage !== -1 && nextUsage < idx) this.ingestLine(buf.toString('utf8', start, idx), file);
          // link de PR aberto pela sessão
          else if (buf.subarray(start, start + PR_LINK.length).equals(PR_LINK)) this.prLine(buf.toString('utf8', start, idx));
          // pedido do usuário? ("type":"user" logo no começo da linha e sem tool_result)
          else if (
            buf.subarray(start, Math.min(idx, start + 400)).indexOf(TYPE_USER) !== -1 &&
            buf.subarray(start, idx).indexOf(TOOL_USE_ID) === -1
          ) {
            this.promptLine(buf.toString('utf8', start, idx), file);
          }
          start = idx + 1;
        }
        rec.rest = Buffer.from(buf.subarray(start));
      });
      stream.on('end', resolve);
      stream.on('error', resolve);
    });
    rec.offset = size;
    this.blockCache = null;
    return true;
  }

  sess(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { cost: 0, tokens: 0, input: 0, output: 0, lastTs: 0, lastUsage: null, model: null, cwd: null };
      this.sessions.set(id, s);
    }
    return s;
  }

  promptLine(line, file) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.type !== 'user' || o.isSidechain || o.isMeta || !o.message) return;
    const c = o.message.content;
    const isPrompt =
      typeof c === 'string' ||
      (Array.isArray(c) && c.some((x) => x && x.type === 'text') && !c.some((x) => x && x.type === 'tool_result'));
    if (!isPrompt) return;
    this.timing(o.sessionId || path.basename(file, '.jsonl'), file, 'prompt', Date.parse(o.timestamp) || 0, o.cwd);
  }

  prLine(line) {
    try {
      const o = JSON.parse(line);
      if (o.sessionId && o.prUrl) this.prs.set(o.sessionId, { number: o.prNumber, url: o.prUrl, repo: o.prRepository, at: Date.parse(o.timestamp) || 0 });
    } catch {
      /* linha incompleta */
    }
  }

  prFor(sessionId) {
    return this.prs.get(sessionId) || null;
  }

  // Um turno vai do pedido do usuário até a última resposta do Claude antes do próximo pedido.
  // O tempo em que o Claude fica parado esperando você NÃO conta.
  timing(sid, file, kind, ts, cwd) {
    if (!ts) return;
    let w = this.work.get(sid);
    if (!w) {
      w = { project: projectKeyOf(file), file, cwd: null, days: new Map(), intervals: [], turnStart: 0, turnEnd: 0, first: ts };
      this.work.set(sid, w);
    }
    if (cwd && !w.cwd) w.cwd = cwd;
    if (kind === 'prompt') {
      this.closeTurn(w);
      w.turnStart = ts;
      w.turnEnd = ts;
      if (ts < w.first) w.first = ts;
    } else if (w.turnStart && ts >= w.turnStart && ts > w.turnEnd) {
      w.turnEnd = ts;
    }
    this.projectCache.delete(w.project);
    this.timelineCache = null;
  }

  closeTurn(w) {
    if (w.turnStart && w.turnEnd > w.turnStart) {
      const k = dayKey(w.turnStart);
      const dur = Math.min(w.turnEnd - w.turnStart, MAX_TURN_MS);
      w.days.set(k, (w.days.get(k) || 0) + dur);
      // intervalos recentes (para a linha do tempo do dia)
      if (w.turnStart > Date.now() - KEEP_INTERVALS_MS) {
        w.intervals.push([w.turnStart, w.turnStart + dur]);
        if (w.intervals.length > 400) w.intervals.splice(0, w.intervals.length - 400);
      }
    }
    w.turnStart = 0;
    w.turnEnd = 0;
  }

  sumWork(w, today) {
    let total = 0;
    let td = 0;
    for (const [k, v] of w.days) {
      total += v;
      if (k === today) td += v;
    }
    if (w.turnStart && w.turnEnd > w.turnStart) {
      const open = Math.min(w.turnEnd - w.turnStart, MAX_TURN_MS);
      total += open;
      if (dayKey(w.turnStart) === today) td += open;
    }
    return { total, today: td };
  }

  // Lê (uma vez) todos os logs antigos de um projeto, para o total ser o total de verdade.
  ensureProject(key) {
    if (!key || this.fullScanned.has(key)) return;
    this.fullScanned.add(key);
    (async () => {
      const dir = path.join(cfg.PROJECTS_DIR, key);
      let items = [];
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      let touched = false;
      for (const it of items) {
        if (!it.isFile() || !it.name.endsWith('.jsonl')) continue;
        const f = path.join(dir, it.name);
        try {
          const st = await fsp.stat(f);
          if (await this.scanFile(f, st.size)) touched = true;
        } catch {
          /* ignora */
        }
      }
      this.projectCache.delete(key);
      if (touched) this.emit('change');
    })();
  }

  workView(sessionId, projectKey) {
    const today = dayKey(Date.now());
    const sw = this.work.get(sessionId);
    const session = sw ? this.sumWork(sw, today) : null;
    let project = null;
    if (projectKey) {
      const hit = this.projectCache.get(projectKey);
      if (hit && hit.day === today && Date.now() - hit.at < 5e3) project = hit.value;
      else {
        let total = 0;
        let td = 0;
        let sessions = 0;
        let first = 0;
        for (const w of this.work.values()) {
          if (w.project !== projectKey) continue;
          const x = this.sumWork(w, today);
          if (!x.total) continue;
          total += x.total;
          td += x.today;
          sessions++;
          if (!first || w.first < first) first = w.first;
        }
        project = sessions ? { total, today: td, sessions, first } : null;
        this.projectCache.set(projectKey, { at: Date.now(), day: today, value: project });
      }
    }
    return session || project ? { session, project } : null;
  }

  // Linha do tempo de hoje: por projeto, os intervalos em que o Claude trabalhou.
  timelineView() {
    const now = Date.now();
    if (this.timelineCache && now - this.timelineCache.at < 10e3) return this.timelineCache.value;
    const d0 = new Date(now);
    d0.setHours(0, 0, 0, 0);
    const dayStart = d0.getTime();
    const byProject = new Map();
    for (const w of this.work.values()) {
      const list = w.intervals.slice();
      if (w.turnStart && w.turnEnd > w.turnStart) list.push([w.turnStart, Math.min(w.turnEnd, w.turnStart + MAX_TURN_MS)]);
      for (const [a, b] of list) {
        if (b <= dayStart) continue;
        let p = byProject.get(w.project);
        if (!p) {
          p = { key: w.project, name: w.cwd ? path.basename(w.cwd) : w.project, intervals: [] };
          byProject.set(w.project, p);
        }
        if (w.cwd && p.name === w.project) p.name = path.basename(w.cwd);
        p.intervals.push([Math.max(a, dayStart), Math.min(b, now)]);
      }
    }
    const projects = [];
    for (const p of byProject.values()) {
      // junta intervalos sobrepostos (várias sessões do mesmo projeto ao mesmo tempo)
      p.intervals.sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const iv of p.intervals) {
        const last = merged[merged.length - 1];
        if (last && iv[0] <= last[1] + 60e3) last[1] = Math.max(last[1], iv[1]);
        else merged.push([iv[0], iv[1]]);
      }
      const total = merged.reduce((t, [a, b]) => t + (b - a), 0);
      // nomes amigáveis para as pastas de rascunho do app Claude; esconde o que durou menos de 2 min
      const name = /^scratch-\d{4}-\d{2}-\d{2}/.test(p.name) ? 'rascunho (app)' : p.name;
      if (total >= 120e3) projects.push({ key: p.key, name, total, intervals: merged });
    }
    // pastas diferentes com o mesmo nome (ex.: vários "rascunho (app)") viram uma linha só
    const byName = new Map();
    for (const p of projects) {
      const q = byName.get(p.name);
      if (!q) byName.set(p.name, p);
      else {
        const all = [...q.intervals, ...p.intervals].sort((x, y) => x[0] - y[0]);
        const merged = [];
        for (const iv of all) {
          const last = merged[merged.length - 1];
          if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
          else merged.push([iv[0], iv[1]]);
        }
        q.intervals = merged;
        q.total = merged.reduce((t, [a, b]) => t + (b - a), 0);
      }
    }
    projects.length = 0;
    projects.push(...byName.values());
    projects.sort((a, b) => b.total - a.total);
    const first = projects.length ? Math.min(...projects.map((p) => p.intervals[0][0])) : now;
    const value = { dayStart, from: Math.floor(first / 3600e3) * 3600e3, to: now, projects: projects.slice(0, 8) };
    this.timelineCache = { at: now, value };
    return value;
  }

  ingestLine(line, file) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.type !== 'assistant' || !o.message || !o.message.usage) return;
    const m = o.message;
    const u = m.usage;
    const model = m.model || 'unknown';
    const ts = Date.parse(o.timestamp) || 0;
    const sid = o.sessionId || path.basename(file, '.jsonl');
    const s = this.sess(sid);
    if (!o.isSidechain) this.timing(sid, file, 'assistant', ts, o.cwd);
    if (!o.isSidechain && model !== '<synthetic>' && ts >= s.lastTs) {
      s.lastTs = ts;
      s.lastUsage = u;
      s.model = model;
      if (o.cwd) s.cwd = o.cwd;
    }
    const key = m.id ? `${m.id}:${o.requestId || ''}` : null;
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const tokens =
      (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const cost = costFor(model, u);
    s.cost += cost;
    s.tokens += tokens;
    s.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    s.output += u.output_tokens || 0;
    if (ts > Date.now() - KEEP_MS) this.entries.push({ ts, tokens, cost, key });
  }

  prune() {
    const cutoff = Date.now() - KEEP_MS;
    if (!this.entries.length || this.entries[0].ts >= cutoff) {
      // entradas chegam fora de ordem entre arquivos; poda completa só quando necessário
      if (!this.entries.some((e) => e.ts < cutoff)) return;
    }
    const keep = [];
    for (const e of this.entries) {
      if (e.ts >= cutoff) keep.push(e);
      else if (e.key) this.seen.delete(e.key);
    }
    this.entries = keep;
    this.blockCache = null;
  }

  // ---------- calibração: "USD equivalentes por 1% do limite" ----------
  // Sempre que chega uma leitura oficial (statusLine/OAuth), compara com o custo local da mesma
  // janela. Assim, quando a leitura oficial some (ex.: usando só o app desktop), as barras
  // continuam andando por estimativa a partir dos logs locais.
  calibrate(key) {
    const w = this.windows[key];
    const now = Date.now();
    if (!this.scanReady || !w || !w.resetsAt || w.pct < 3 || now - (this.calAt[key] || 0) < 5 * MIN) return;
    const start = w.resetsAt - SPAN[key];
    const cost = this.costSince(start, true);
    if (cost <= 0.01) return;
    this.calAt[key] = now;
    const limit = cost / (w.pct / 100);
    const prop = CAL_KEY[key];
    const prev = this.cal[prop];
    this.cal[prop] = prev ? prev * 0.6 + limit * 0.4 : limit;
    if (key === 'seven_day') this.cal.weekResetsAt = w.resetsAt;
    this.cal.updatedAt = now;
    try {
      fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
      fs.writeFileSync(CAL_FILE, JSON.stringify(this.cal, null, 2));
    } catch {
      /* sem persistência, segue em memória */
    }
  }

  costSince(ts, fresh = false) {
    const c = this.sinceCache || (this.sinceCache = new Map());
    const hit = c.get(ts);
    if (!fresh && hit && Date.now() - hit.at < 15e3) return hit.cost;
    let cost = 0;
    for (const e of this.entries) if (e.ts >= ts) cost += e.cost;
    if (c.size > 20) c.clear();
    c.set(ts, { at: Date.now(), cost });
    return cost;
  }

  limitFor(key) {
    return (key === 'five_hour' ? cfg.EST_5H_USD : cfg.EST_7D_USD) || this.cal[CAL_KEY[key]] || 0;
  }

  totals() {
    const now = Date.now();
    if (this.blockCache && now - this.blockCache.at < 15e3) return this.blockCache.value;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = { tokens: 0, cost: 0 };
    const week = { tokens: 0, cost: 0 };
    const recent = [];
    for (const e of this.entries) {
      if (e.ts >= now - 7 * DAY) {
        week.tokens += e.tokens;
        week.cost += e.cost;
      }
      if (e.ts >= dayStart.getTime()) {
        today.tokens += e.tokens;
        today.cost += e.cost;
      }
      if (e.ts >= now - DAY) recent.push(e);
    }
    // Blocos de 5 h no estilo ccusage: começam na hora cheia da primeira mensagem.
    recent.sort((a, b) => a.ts - b.ts);
    let blk = null;
    for (const e of recent) {
      if (!blk || e.ts >= blk.end) {
        const start = Math.floor(e.ts / HOUR) * HOUR;
        blk = { start, end: start + 5 * HOUR, tokens: 0, cost: 0 };
      }
      blk.tokens += e.tokens;
      blk.cost += e.cost;
    }
    const block = blk && now < blk.end ? blk : null;
    const value = { today, week, block };
    this.blockCache = { at: now, value };
    return value;
  }

  windowView(key, totals) {
    const now = Date.now();
    const w = this.windows[key];
    const lim = this.limitFor(key);
    if (w && w.resetsAt && w.resetsAt > now && now - w.updatedAt < SPAN[key]) {
      // leitura oficial ainda dentro da janela; se envelheceu, soma o que foi gasto depois dela
      let pct = w.pct;
      let extrapolated = false;
      if (lim && now - w.updatedAt > 3 * MIN) {
        pct += (this.costSince(w.updatedAt) / lim) * 100;
        extrapolated = true;
      }
      return { pct, resetsAt: w.resetsAt, source: w.source, updatedAt: w.updatedAt, extrapolated };
    }
    if (w && w.resetsAt && w.resetsAt <= now && now - w.resetsAt < HOUR && !lim) {
      return { pct: 0, resetsAt: null, source: w.source, reset: true };
    }
    if (key === 'five_hour' && this.fiveHourNone && now - this.fiveHourNone < 15 * MIN) {
      return { pct: null, resetsAt: null, source: 'oauth', none: true };
    }
    if (key === 'five_hour') {
      const b = totals.block;
      return {
        pct: lim ? ((b ? b.cost : 0) / lim) * 100 : null,
        resetsAt: b ? b.end : null,
        source: 'estimativa',
        calibrated: !!lim,
      };
    }
    let resetsAt = null;
    let cost = totals.week.cost;
    if (this.cal.weekResetsAt) {
      let end = this.cal.weekResetsAt;
      while (end <= now) end += 7 * DAY;
      resetsAt = end;
      cost = this.costSince(end - 7 * DAY);
    }
    return { pct: lim ? (cost / lim) * 100 : null, resetsAt, source: 'estimativa', calibrated: !!lim };
  }

  view() {
    const totals = this.totals();
    return {
      fiveHour: this.windowView('five_hour', totals),
      sevenDay: this.windowView('seven_day', totals),
      models: this.modelsView(),
      plan: this.plan,
      oauth: this.oauth.status,
      calibration: this.cal.updatedAt ? { fiveHourUsd: this.cal.fiveHourUsd || null, sevenDayUsd: this.cal.sevenDayUsd || null, at: this.cal.updatedAt } : null,
      totals,
      scanReady: this.scanReady,
    };
  }

  sessionMetrics(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const u = s.lastUsage;
    const used = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null;
    const size = cfg.CONTEXT_WINDOW_OVERRIDE || contextWindowFor(s.model);
    return {
      cost: s.cost,
      tokens: s.tokens,
      input: s.input,
      output: s.output,
      model: s.model,
      cwd: s.cwd,
      context: used != null ? { used, size, pct: (used / size) * 100 } : null,
    };
  }
}

async function listJsonl(dir, depth) {
  const out = [];
  async function walk(d, level) {
    let items;
    try {
      items = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) {
        if (level < depth) await walk(p, level + 1);
      } else if (it.isFile() && it.name.endsWith('.jsonl')) out.push(p);
    }
  }
  await walk(dir, 0);
  return out;
}

// pasta do projeto dentro de ~/.claude/projects (ex.: "-Users-voce-code-loja")
function projectKeyOf(file) {
  return path.relative(cfg.PROJECTS_DIR, file).split(path.sep)[0];
}
