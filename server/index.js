// ClawdDesk — ponte PC ↔ celular. Recebe hooks/statusLine do Claude Code e transmite o
// estado em tempo real via WebSocket para o PWA servido na raiz "/".
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import * as cfg from './config.js';
import { lanAddresses } from './net.js';
import { UsageTracker } from './usage.js';
import { SessionStore } from './state.js';
import { Simulator } from './simulator.js';
import { Approvals } from './approvals.js';
import { GitTracker } from './git.js';
import { ColorRegistry } from './colors.js';
import { FxRate } from './fx.js';
import { describeTool } from './state.js';
import { LocalSessions } from './localsessions.js';
import { WebSessions } from './websessions.js';
import { SatelliteHub, SatelliteLink } from './satellite.js';
import { Auth } from './auth.js';

const usage = new UsageTracker();
const store = new SessionStore(usage);
const sim = new Simulator();
const approvals = new Approvals();
const gitTracker = new GitTracker();
store.git = gitTracker;
const colors = new ColorRegistry();
const fx = new FxRate();
store.colors = colors;

const logLine = (msg) => {
  if (!cfg.QUIET) console.log(`  [${new Date().toTimeString().slice(0, 8)}] ${msg}`);
};

// login com usuário e senha (sempre no modo servidor; no local, só se houver usuário criado)
const auth = new Auth();
let authBootMsg = null;
try {
  authBootMsg = await auth.bootstrap();
} catch (e) {
  authBootMsg = `não deu para criar o usuário de CLAWDDESK_ADMIN_USER: ${e.message}`;
}
if (cfg.SERVER && !auth.users.length) {
  const b = (s) => `\x1b[1m${s}\x1b[0m`;
  console.error(`\n  ✖ Modo servidor sem nenhum usuário: ninguém conseguiria entrar.${authBootMsg ? `\n    (${authBootMsg})` : ''}`);
  console.error(`    Crie o primeiro: ${b('npm run user -- add SEU_NOME')}`);
  console.error(`    ou defina ${b('CLAWDDESK_ADMIN_USER')} e ${b('CLAWDDESK_ADMIN_PASSWORD')} (mínimo de 8 caracteres) e inicie de novo.\n`);
  process.exit(1);
}
// com login, o código para ligar PCs é gerado na tela (uso único, 10 min), não fica fixo no terminal
if (auth.enabled) approvals.useOneTimeCodes();

// sessões abertas neste PC (fichas do Claude Code em ~/.claude/sessions)
const localSessions = new LocalSessions();
localSessions.on('change', () => store.syncLocal(localSessions));

// outros computadores: este PC como principal (recebe) e/ou como satélite (envia para outro)
const hub = new SatelliteHub(approvals);
const link = new SatelliteLink({
  snapshotPart: () => ({
    sessions: store.list().slice(0, 12),
    timeline: usage.timelineView(),
    approvals: approvals.view().open,
    bridgeIds: [...localSessions.bridgeIds(), ...usage.bridgeIds],
    usage: usage.view(), // limites e gastos (o ClawdDesk online mostra os da conta a partir daqui)
  }),
  // Permitir/Negar feito no celular do PC principal para um pedido deste PC
  onDecision: (id, decision) => {
    const item = approvals.resolve(id, decision, 'celular');
    if (!item) return { ok: false, status: 410, error: 'esse pedido já foi respondido ou expirou' };
    store.remoteDecision(item.sessionId, decision, item.tool);
    logLine(`📱 ${item.project}: ${decision === 'allow' ? 'PERMITIDO' : 'NEGADO'} pelo celular (via ClawdDesk principal) · ${item.tool.name} ${item.tool.target}`);
    return { ok: true };
  },
});

// sessões da web (claude.ai/code) e de outros PCs com Controle Remoto, pela conta OAuth
const web = new WebSessions(usage, () => new Set([...localSessions.bridgeIds(), ...usage.bridgeIds, ...hub.bridgeIds()]));

// ordem na tela: quem precisa de você > trabalhando > concluído > parado; depois o mais recente
const PRIORITY = { permission: 3, thinking: 2, done: 1, idle: 0 };
const byPriority = (a, b) => (PRIORITY[b.state] || 0) - (PRIORITY[a.state] || 0) || b.lastEventAt - a.lastEventAt;

// linha do tempo: projetos deste PC + dos outros PCs (mesmo nome = mesma linha)
function mergedTimeline() {
  const tl = usage.timelineView();
  const extra = hub.timelineProjects();
  if (!extra.length) return tl;
  const now = Date.now();
  const byName = new Map(tl.projects.map((p) => [p.name, { ...p, intervals: p.intervals.slice(), hosts: [] }]));
  for (const p of extra) {
    const ivs = p.intervals.filter(([, b]) => b > tl.dayStart).map(([a, b]) => [Math.max(a, tl.dayStart), Math.min(b, now)]);
    if (!ivs.length) continue;
    const q = byName.get(p.name);
    if (q) {
      q.intervals.push(...ivs);
      if (!q.hosts.includes(p.host)) q.hosts.push(p.host);
    } else byName.set(p.name, { key: p.key, name: p.name, total: 0, intervals: ivs, hosts: [p.host], remoteOnly: true });
  }
  const projects = [];
  for (const p of byName.values()) {
    p.intervals.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const iv of p.intervals) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    p.intervals = merged;
    p.total = merged.reduce((t, [a, b]) => t + (b - a), 0);
    if (p.total >= 120e3) projects.push(p);
  }
  projects.sort((a, b) => b.total - a.total);
  const first = projects.length ? Math.min(...projects.map((p) => p.intervals[0][0])) : now;
  return { ...tl, from: Math.floor(first / 3600e3) * 3600e3, to: now, projects: projects.slice(0, 10) };
}

// Versão da interface = hash dos arquivos de public/. Quando muda (arquivo editado ou servidor
// reiniciado com código novo), os celulares conectados recarregam sozinhos.
function computeVersion() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const it of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else if (it.isFile()) {
        h.update(path.relative(cfg.PUBLIC_DIR, p));
        h.update(fs.readFileSync(p));
      }
    }
  };
  try {
    walk(cfg.PUBLIC_DIR);
  } catch {
    /* pasta inacessível: mantém versão vazia */
  }
  return h.digest('hex').slice(0, 10);
}
let uiVersion = computeVersion();

function withColors(tl) {
  return { ...tl, projects: tl.projects.map((p) => ({ ...p, colorIndex: colors.get(p.name) })) };
}

function snapshot() {
  const withColor = (x) => (x.origin ? { ...x, colorIndex: colors.get(x.project) } : x);
  const sessions = [...store.list(), ...hub.sessions().map(withColor), ...web.view().map(withColor)].sort(byPriority);
  const ap = approvals.view();
  const base = {
    serverTime: Date.now(),
    primary: sessions[0] || null,
    sessions: sessions.slice(0, 10),
    usage: cfg.SERVER ? hub.usage() || { ...usage.view(), oauth: 'servidor' } : usage.view(),
    mode: cfg.MODE,
    hooks: store.hooks,
    statusline: store.statusline,
    sim: { active: false },
    version: uiVersion,
    approvals: { ...ap, open: [...ap.open, ...hub.approvalsView()] },
    timeline: withColors(mergedTimeline()),
    fx: fx.view(),
    remote: { machine: cfg.MACHINE_NAME, web: web.info(), satellites: hub.view(), link: link.view() },
  };
  return sim.apply(base);
}

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Hooks e statusLine: só do próprio PC. Um pedido que passou por proxy (cabeçalhos X-Forwarded-*)
// também é recusado, mesmo chegando de 127.0.0.1. No modo servidor essas rotas nem existem.
const localOnly = (req, res, next) => {
  if (cfg.SERVER) return res.status(404).json({ error: 'não existe no modo servidor' });
  const proxied = req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip'];
  return LOCAL.has(req.socket.remoteAddress) && !proxied ? next() : res.status(403).json({ error: 'permitido apenas a partir do próprio PC' });
};

// mesmo site? (impede que outra página use o navegador logado para aprovar ou mudar algo)
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
}
// endereço de quem chamou (atrás do proxy, vem do X-Forwarded-For que o proxy acrescentou)
function clientIp(req) {
  const xff = cfg.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean) : [];
  const ip = xff.length ? xff[Math.max(0, xff.length - cfg.TRUST_PROXY)] : req.socket.remoteAddress;
  return String(ip || '').replace(/^::ffff:/, '');
}
const who = (req) => (auth.enabled ? auth.check(req.headers.cookie) : null);
// rotas que exigem login (quando ele está ligado)
const requireLogin = (req, res, next) => {
  if (!auth.enabled) return next();
  const a = who(req);
  if (!a) return res.status(401).json({ error: 'faça login', login: true });
  if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'origem não permitida' });
  req.auth = a;
  next();
};
// endereço que os outros PCs usam para chegar aqui
function publicUrl(req) {
  if (cfg.PUBLIC_URL) return cfg.PUBLIC_URL;
  const host = String(req.headers.host || '');
  // no PC, "localhost" não serve para os outros: usa o endereço da rede (no servidor, vale o do navegador)
  if (!host || (!cfg.SERVER && /^(localhost|127\.|\[::1\])/.test(host))) {
    const lan = lanAddresses()[0];
    return lan ? `http://${lan.address}:${cfg.PORT}` : `http://ENDEREÇO:${cfg.PORT}`;
  }
  return `${req.protocol}://${host}`;
}

const app = express();
app.disable('x-powered-by');
if (cfg.TRUST_PROXY) app.set('trust proxy', cfg.TRUST_PROXY);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- login
app.get('/api/me', (req, res) => {
  const a = who(req);
  res.json({ login: auth.enabled, user: a ? a.user : null, mode: cfg.MODE });
});
app.post('/api/login', express.json({ limit: '4kb' }), async (req, res) => {
  if (!auth.enabled) return res.status(404).json({ ok: false, error: 'o login não está ligado' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'origem não permitida' });
  const ip = clientIp(req);
  const { user, password } = req.body || {};
  const r = await auth.login(user, password, ip, req.headers['user-agent']);
  if (!r.ok) {
    logLine(`🔐 Login recusado (${ip}): ${r.error}`);
    return res.status(r.status).json({ ok: false, error: r.error });
  }
  logLine(`🔐 ${r.user} entrou (${ip})`);
  res.setHeader('Set-Cookie', auth.cookie(r.token, req.secure));
  res.json({ ok: true, user: r.user });
});
app.post('/api/logout', (req, res) => {
  const a = who(req);
  if (a && sameOrigin(req)) {
    auth.logout(a.hash);
    for (const c of wss.clients) if (c.auth && c.auth.hash === a.hash) c.close(4401, 'login');
  }
  res.setHeader('Set-Cookie', auth.clearCookie(req.secure));
  res.json({ ok: true });
});

// ---- PCs ligados a este ClawdDesk (com login): código de uso único e lista para remover
app.post('/api/link-code', requireLogin, (req, res) => {
  if (!auth.enabled) return res.status(404).json({ error: 'sem login, o código fica no terminal do PC' });
  const r = approvals.newCode();
  logLine(`🔐 ${req.auth.user} gerou um código para ligar um PC (vale 10 min)`);
  res.json({ ...r, url: publicUrl(req) });
});
app.get('/api/devices', requireLogin, (req, res) => {
  const online = new Map(hub.view().map((s) => [s.id, s]));
  res.json(approvals.devicesView().map((d) => ({ ...d, online: !!(online.get(d.id) || {}).online, host: (online.get(d.id) || {}).host || null })));
});
app.post('/api/devices/remove', requireLogin, express.json({ limit: '2kb' }), (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const d = approvals.removeDevice(id);
  if (!d) return res.status(404).json({ ok: false, error: 'esse PC já foi removido' });
  hub.drop(id);
  logLine(`🔐 ${req.auth ? req.auth.user : 'alguém'} removeu "${d.label}"`);
  res.json({ ok: true });
});

// ---- páginas: sem login, a tela principal manda para /login
app.get(['/', '/index.html'], (req, res, next) => (auth.enabled && !who(req) ? res.redirect(302, '/login') : next()));
app.get(['/login', '/login.html'], (req, res) => {
  if (!auth.enabled || who(req)) return res.redirect(302, '/');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(cfg.PUBLIC_DIR, 'login.html'));
});

// Hooks e statusLine só são aceitos do próprio PC (localhost).
app.post('/api/event', localOnly, express.json({ limit: '5mb' }), (req, res) => {
  try {
    const p = req.body || {};
    store.handleHook(p);
    // arquivos podem ter mudado: relê o git da pasta da sessão
    if (p.cwd && /^(PostToolUse|Stop|SessionStart|UserPromptSubmit)$/.test(p.hook_event_name || '')) gitTracker.refresh(p.cwd);
    // a sessão saiu do "aguardando" (ex.: você respondeu no PC): libera o hook que espera o celular
    const s = p.session_id && store.sessions.get(p.session_id);
    if (p.session_id && (!s || s.state !== 'permission')) approvals.clearSession(p.session_id);
  } catch (e) {
    console.error('  ⚠ evento inválido:', e.message);
  }
  res.status(204).end();
});

// ---- aprovar/negar pelo celular
// Hook síncrono de PermissionRequest: registra o pedido e espera a resposta do celular (long-poll).
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
app.post('/api/permission/request', localOnly, express.json({ limit: '5mb' }), (req, res) => {
  const p = req.body || {};
  try {
    store.handleHook({ ...p, hook_event_name: 'PermissionRequest' });
  } catch (e) {
    console.error('  ⚠ pedido de permissão inválido:', e.message);
  }
  // perguntas com opções não dá para responder por hook: ficam só no PC
  if (QUESTION_TOOLS.has(p.tool_name)) return res.json({ decision: null, reason: 'pergunta' });
  approvals.request(
    {
      sessionId: p.session_id || 'default',
      project: p.cwd ? path.basename(p.cwd) : 'Claude Code',
      tool: describeTool(p.tool_name, p.tool_input),
      mode: p.permission_mode,
      entrypoint: p.entrypoint,
    },
    res
  );
});

app.post('/api/permission/decision', express.json({ limit: '10kb' }), async (req, res) => {
  const { id, decision, token } = req.body || {};
  // quem pode responder: com login, quem está logado; sem login, o aparelho pareado pelo código
  const allowed = auth.enabled ? !!who(req) && sameOrigin(req) : !!approvals.verify(token);
  if (!allowed) return res.status(401).json({ ok: false, error: auth.enabled ? 'faça login de novo' : 'aparelho não pareado', login: auth.enabled });
  // pedido de OUTRO PC (modo satélite): repassa a resposta para ele
  if (typeof id === 'string' && id.startsWith('sat:')) {
    if (decision !== 'allow' && decision !== 'deny') return res.status(400).json({ ok: false, error: 'decisão inválida' });
    const r = await hub.decide(id, decision);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    if (r.item) logLine(`📱 ${r.item.project} (${r.host}): ${decision === 'allow' ? 'PERMITIDO' : 'NEGADO'} pelo celular · ${r.item.tool.name} ${r.item.tool.target}`);
    return res.json({ ok: true });
  }
  if (typeof id === 'string' && id.startsWith('sim-')) {
    const ok = sim.remoteDecide(id, decision);
    return res.status(ok ? 200 : 410).json(ok ? { ok: true } : { ok: false, error: 'esse pedido já foi respondido ou expirou' });
  }
  const r = approvals.decide(String(id || ''), decision);
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
  store.remoteDecision(r.item.sessionId, decision, r.item.tool);
  if (!cfg.QUIET) {
    const t = new Date().toTimeString().slice(0, 8);
    console.log(`  [${t}] 📱 ${r.item.project}: ${decision === 'allow' ? 'PERMITIDO' : 'NEGADO'} pelo celular · ${r.item.tool.name} ${r.item.tool.target}`);
  }
  res.json({ ok: true });
});

// pareamento: o código aparece no terminal do PC e na página aberta no próprio PC
app.post('/api/pair', express.json({ limit: '2kb' }), (req, res) => {
  const ip = clientIp(req);
  const label = String((req.body && req.body.label) || '');
  const r = approvals.pair(req.body && req.body.code, label, ip);
  if (r.ok) logLine(/^PC:/.test(label) ? `🔐 ${label.slice(3).trim() || 'Outro PC'} pareado (${ip}) — as sessões dele vão aparecer aqui` : `🔐 Aparelho pareado (${ip}) — já pode aprovar pedidos pelo celular`);
  else logLine(`🔐 Tentativa de pareamento recusada (${ip}): ${r.error}`);
  res.status(r.ok ? 200 : 403).json(r);
});
app.post('/api/unpair', express.json({ limit: '2kb' }), (req, res) => res.json({ ok: approvals.unpair(req.body && req.body.token) }));
app.get('/api/pair/code', localOnly, (req, res) =>
  auth.enabled ? res.status(404).json({ error: 'com login, gere o código na tela' }) : res.json({ code: approvals.codeFormatted, paired: approvals.devices.length })
);

app.post('/api/statusline', localOnly, express.json({ limit: '2mb' }), (req, res) => {
  try {
    store.handleStatusline(req.body || {});
  } catch (e) {
    console.error('  ⚠ statusLine inválido:', e.message);
  }
  res.status(204).end();
});

app.get('/api/state', requireLogin, (req, res) => res.json(snapshot()));

app.post('/api/simulate', requireLogin, express.json({ limit: '10kb' }), (req, res) => {
  const ok = sim.run(String((req.body && req.body.scenario) || ''));
  res.status(ok ? 200 : 400).json({ ok, sim: sim.view() });
});

let qrSvgCache = null;
app.get('/api/info', async (req, res) => {
  // sem login: só o bastante para o "npm run link" saber que aqui é um ClawdDesk
  if (auth.enabled && !who(req)) return res.json({ app: 'clawddesk', port: cfg.PORT, mode: cfg.MODE, login: true });
  const lan = cfg.SERVER ? [] : lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${cfg.PORT}` }));
  if (!qrSvgCache && lan[0]) {
    qrSvgCache = await QRCode.toString(lan[0].url, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
  }
  res.json({ app: 'clawddesk', port: cfg.PORT, mode: cfg.MODE, login: auth.enabled, lan, qrSvg: cfg.SERVER ? null : qrSvgCache, hooksInstalled: cfg.SERVER ? null : hooksInstalled() });
});

app.use(
  express.static(cfg.PUBLIC_DIR, {
    setHeaders(res, p) {
      if (/(sw\.js|\.html|manifest\.json)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
// o ws repassa erros do servidor HTTP (ex.: porta em uso); quem trata é o server.on('error') abaixo
wss.on('error', () => {});

// ---- aparelhos conectados: quem é e se está com a versão atual da interface
function deviceOf(ua = '') {
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'navegador';
}

function logClient(ws, what) {
  ws.info.logged = true;
  if (cfg.QUIET) return;
  const i = ws.info;
  const t = new Date().toTimeString().slice(0, 8);
  const who = `${i.self ? '💻' : '📱'} ${i.device} ${i.ip}${i.user ? ` (${i.user})` : ''}`;
  if (what === 'desconectado') return console.log(`  [${t}] ${who} desconectado`);
  const status = !i.version
    ? '⚠  versão ANTIGA — recarregue a página uma vez (⋮ → ↻); depois ela se atualiza sozinha'
    : i.version === uiVersion
      ? 'versão atual ✓'
      : 'versão anterior — atualizando sozinho…';
  console.log(`  [${t}] ${who} conectado · ${status}`);
}

// mesmo site no WebSocket (o navegador manda Origin; os outros PCs, não)
function wsOriginOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  const ip = clientIp(req);
  const self = !cfg.SERVER && (ip === '127.0.0.1' || ip === '::1' || lanAddresses().some((a) => a.address === ip));
  ws.info = { ip, self, device: self ? 'este PC' : deviceOf(req.headers['user-agent']), connectedAt: Date.now(), version: null };
  // Quem pode ver a tela: com login, só quem tem o cookie válido. Outros PCs (satélites) entram
  // sem cookie, mas só passam se mandarem "satellite-hello" com o token do pareamento.
  ws.cookie = req.headers.cookie || '';
  ws.auth = auth.enabled ? auth.check(ws.cookie) : null;
  ws.viewer = !auth.enabled || (!!ws.auth && wsOriginOk(req));
  if (ws.auth) ws.info.user = ws.auth.user;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (m) => {
    const txt = String(m);
    if (txt === 'ping') return ws.viewer || ws.sat ? ws.send('{"type":"pong"}') : ws.close(4401, 'login');
    let msg;
    try {
      msg = JSON.parse(txt);
    } catch {
      return;
    }
    if (msg && msg.type === 'hello' && typeof msg.version === 'string') {
      if (!ws.viewer) return ws.close(4401, 'login');
      const changed = ws.info.version !== msg.version.slice(0, 40);
      ws.info.version = msg.version.slice(0, 40);
      // com login, estar logado já permite responder pelo celular; sem login, vale o pareamento
      ws.info.paired = auth.enabled ? true : !!approvals.verify(msg.token);
      ws.send(JSON.stringify({ type: 'auth', paired: ws.info.paired, login: auth.enabled, user: ws.auth ? ws.auth.user : null }));
      if (changed) logClient(ws, 'conectado');
      hub.broadcastStatus(phonesOnline());
    }
    // outro computador (modo satélite)
    else if (msg && msg.type === 'satellite-hello') {
      clearTimeout(ws.helloTimer);
      ws.viewer = false;
      hub.hello(ws, msg);
      if (ws.sat) hub.broadcastStatus(phonesOnline());
    } else if (msg && msg.type === 'satellite-state' && ws.sat) hub.state(ws, msg);
    else if (msg && msg.type === 'decision-result' && ws.sat) hub.result(msg);
  });
  ws.helloTimer = ws.viewer
    ? // interfaces antigas não mandam "hello": depois de 6 s sem resposta, avisa que precisa recarregar
      setTimeout(() => {
        if (!ws.info.version) logClient(ws, 'conectado');
      }, 6000)
    : // sem login e sem ser outro PC: fecha
      setTimeout(() => {
        if (!ws.sat) ws.close(4401, 'login');
      }, 10e3);
  ws.on('close', () => {
    clearTimeout(ws.helloTimer);
    if (ws.sat) return hub.closed(ws);
    if (ws.info.logged) logClient(ws, 'desconectado');
    hub.broadcastStatus(phonesOnline());
  });
  if (ws.viewer) {
    ws.send(JSON.stringify({ type: 'access', login: auth.enabled, user: ws.auth ? ws.auth.user : null, mode: cfg.MODE }));
    ws.send(JSON.stringify({ type: 'snapshot', data: snapshot() }));
  } else ws.send(JSON.stringify({ type: 'login-required' }));
});

app.get('/api/clients', requireLogin, (req, res) =>
  res.json(
    [...wss.clients].filter((c) => c.viewer).map((c) => ({
      ip: c.info.ip,
      device: c.info.device,
      version: c.info.version,
      current: c.info.version === uiVersion,
      connectedAt: c.info.connectedAt,
    }))
  )
);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    // login removido, senha trocada ou expirado: tira a tela do ar
    if (auth.enabled && ws.viewer && !auth.check(ws.cookie)) {
      ws.close(4401, 'login');
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20e3).unref();

let pending = null;
function broadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    if (!wss.clients.size) return;
    const viewers = [...wss.clients].filter((ws) => ws.readyState === 1 && ws.viewer);
    if (!viewers.length) return;
    const msg = JSON.stringify({ type: 'snapshot', data: snapshot() });
    for (const ws of viewers) ws.send(msg);
  }, 80);
}
// há celular pareado olhando? (satélites não contam)
const phonesOnline = () => [...wss.clients].some((c) => c.readyState === 1 && c.viewer && c.info && c.info.paired);
const pushToHub = () => link.push();
for (const src of [store, approvals, gitTracker, usage]) {
  src.on('change', broadcast);
  src.on('change', pushToHub);
}
fx.on('change', broadcast);
web.on('change', broadcast);
hub.on('change', broadcast);
link.on('change', broadcast);
hub.on('log', logLine);
link.on('log', logLine);
web.isWatched = () => [...wss.clients].some((c) => c.readyState === 1 && c.viewer);
web.on('status', (st, before) => {
  const msg = {
    ok: '☁  Sessões da web (claude.ai/code) conectadas',
    'sem-acesso': '⚠  A conta não permite listar as sessões da web; elas não vão aparecer',
    'nao-autorizado': '⚠  Login recusado ao listar as sessões da web; rode: claude auth login',
  }[st];
  if (msg) logLine(msg);
  else if ((st === 'erro' || String(st).startsWith('http-')) && before === 'ok') logLine(`⚠  Sem resposta da lista de sessões da web (${st}); tento de novo em instantes`);
});
// pode esperar a resposta do celular? (celular pareado aqui ou no ClawdDesk principal)
approvals.onlineCheck = () => phonesOnline() || link.phonesOnline;
setInterval(() => hub.broadcastStatus(phonesOnline()), 15e3).unref();
// Mudou o acesso ao uso da conta (API do Claude.ai)? Explica no terminal o que isso significa.
usage.on('oauth', (status) => {
  if (cfg.QUIET) return;
  const y = (s) => `\x1b[33m${s}\x1b[0m`;
  const msg = {
    ok: '🔑 Uso da conta conectado: limites oficiais (todos os seus PCs, app e web)',
    'sem-credenciais': `${y('⚠')}  O Claude Code do terminal não está logado → limites estimados só com este PC. Para ver a conta toda, rode: claude auth login`,
    'token-expirado': `${y('⚠')}  O login do Claude Code no terminal expirou → limites estimados só com este PC. Abra "claude" no terminal para renovar`,
    'nao-autorizado': `${y('⚠')}  A Anthropic recusou o login salvo → limites estimados só com este PC. Rode de novo: claude auth login`,
    limitado: '⏳ API de uso pediu uma pausa; tento de novo em alguns minutos',
  }[status];
  if (msg) console.log(`  [${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);
  else if (status === 'erro' || String(status).startsWith('http-'))
    console.log(`  [${new Date().toLocaleTimeString('pt-BR')}] ${y('⚠')}  Sem resposta da API de uso (${status}); tento de novo em 5 min`);
});
sim.on('change', broadcast);
setInterval(broadcast, 30e3).unref(); // mantém relógios sincronizados

let versionTimer = null;
try {
  fs.watch(cfg.PUBLIC_DIR, { recursive: true }, () => {
    clearTimeout(versionTimer);
    versionTimer = setTimeout(() => {
      const v = computeVersion();
      if (v === uiVersion) return;
      uiVersion = v;
      if (!cfg.QUIET) console.log(`  🔄 Interface atualizada (versão ${v}) — os celulares vão recarregar sozinhos`);
      broadcast();
    }, 500);
  });
} catch {
  /* sem fs.watch: a versão só muda ao reiniciar o servidor */
}

function hooksInstalled() {
  try {
    return fs.readFileSync(cfg.SETTINGS_FILE, 'utf8').includes('clawddesk-hook');
  } catch {
    return false;
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✖ A porta ${cfg.PORT} já está em uso. Já existe um ClawdDesk rodando?`);
    console.error(`    Feche-o ou use outra porta: CLAWDDESK_PORT=3457 npm start\n`);
  } else console.error(e);
  process.exit(1);
});

// Modo servidor: nada de Claude Code nesta máquina; só login, PCs ligados e a tela.
function serverBanner(b, c, d) {
  const users = auth.users.map((u) => u.name);
  console.log('');
  console.log(`  ${b('🤖 ClawdDesk')} ${d('— modo servidor (online)')}`);
  console.log('');
  console.log(`  Ouvindo em:  ${c(`http://${cfg.HOST}:${cfg.PORT}`)} ${d(cfg.TRUST_PROXY ? '(atrás do proxy HTTPS)' : '(sem proxy)')}`);
  if (cfg.PUBLIC_URL) console.log(`  Endereço:    ${b(c(cfg.PUBLIC_URL))}`);
  if (authBootMsg) console.log(`  👤 ${authBootMsg}`);
  console.log(`  👤 Usuários: ${b(users.join(', '))} ${d('(npm run user -- list | add | passwd | remove)')}`);
  console.log(`  🖥  PCs ligados: ${approvals.devices.length} ${d('· para ligar outro: entre na tela → 👤 → Conectar um PC')}`);
  console.log(`  ${d('Ctrl+C para encerrar.')}\n`);
}

server.listen(cfg.PORT, cfg.HOST, async () => {
  const lan = lanAddresses();
  const phoneUrl = lan[0] ? `http://${lan[0].address}:${cfg.PORT}` : null;
  const b = (s) => `\x1b[1m${s}\x1b[0m`;
  const c = (s) => `\x1b[36m${s}\x1b[0m`;
  const d = (s) => `\x1b[2m${s}\x1b[0m`;
  if (cfg.SERVER) {
    serverBanner(b, c, d);
    fx.start();
    return;
  }
  console.log('');
  console.log(`  ${b('🤖 ClawdDesk')} ${d('— monitor de mesa para o Claude Code')}`);
  console.log('');
  console.log(`  No PC:       ${c(`http://localhost:${cfg.PORT}`)}`);
  if (phoneUrl) {
    console.log(`  No celular:  ${b(c(phoneUrl))}  ${d(`(${lan[0].name})`)}`);
    for (const a of lan.slice(1, 3)) console.log(`               ${d(`http://${a.address}:${cfg.PORT}  (${a.name})`)}`);
    console.log('');
    try {
      const qr = await QRCode.toString(phoneUrl, { type: 'terminal', small: true });
      console.log(qr.replace(/^/gm, '    '));
    } catch {
      /* sem QR, segue a vida */
    }
  } else {
    console.log(`  ${d('Nenhuma rede local encontrada — conecte o PC ao Wi-Fi.')}`);
  }
  console.log(
    hooksInstalled()
      ? `  ✅ Hooks do Claude Code instalados em ${d(cfg.SETTINGS_FILE)}`
      : `  ⚠  Hooks ainda não instalados → rode ${b('npm run setup-hooks')} e reinicie o Claude Code`
  );
  console.log(
    cfg.OAUTH_ENABLED
      ? `  🔑 Limites 5h/semanal: statusLine + API de uso do Claude.ai ${d('(CLAWDDESK_OAUTH=0 desativa)')}`
      : `  🔑 Limites 5h/semanal: apenas statusLine ${d('(OAuth desativado)')}`
  );
  if (cfg.WEB_ENABLED) console.log(`  ☁  Sessões da web e de outros PCs (claude.ai): ligadas ${d('(CLAWDDESK_WEB=0 desativa)')}`);
  if (link.enabled) console.log(`  🛰  Este PC (${b(cfg.MACHINE_NAME)}) envia as sessões para o ClawdDesk principal em ${c(link.conf.url)} ${d('(npm run unlink desfaz)')}`);
  if (auth.enabled) {
    if (authBootMsg) console.log(`  👤 ${authBootMsg}`);
    console.log(`  🔐 Login ligado: ${b(auth.users.map((u) => u.name).join(', '))} ${d('(npm run user -- list | add | passwd | remove)')}`);
    console.log(`  🖥  Para ligar outro PC: entre na tela → 👤 → Conectar um PC ${d('(o código vale 10 min, uma vez)')}`);
  } else
    console.log(
      `  🔐 Código para parear o celular ou outro PC: ${b(approvals.codeFormatted)}` +
        d(approvals.devices.length ? `  · ${approvals.devices.length} aparelho(s) já pareado(s)` : '')
    );
  // passo a passo para quem está configurando pela primeira vez (npm run setup)
  if (process.env.CLAWDDESK_GUIDE === '1') {
    const y = (s) => `\x1b[33m${s}\x1b[0m`;
    console.log('');
    console.log(`  ${b('📱 Agora no celular:')}`);
    console.log(`   ${y('1.')} Conecte o celular no ${b('mesmo Wi-Fi')} deste computador.`);
    console.log(`   ${y('2.')} Abra a ${b('câmera')} e aponte para o QR Code acima` + (phoneUrl ? ` (ou digite no navegador: ${c(phoneUrl)})` : '') + '.');
    console.log(`   ${y('3.')} Toque em ${b('"Toque para ativar modo mesa"')}. Pronto, o monitor está funcionando!`);
    if (auth.enabled) console.log(`   ${y('4.')} Entre com seu usuário e senha. Logado, o celular já pode aprovar os pedidos.`);
    else console.log(`   ${y('4.')} ${d('Opcional:')} para aprovar pedidos pelo celular, toque em ${b('🧪 → Parear / gerenciar')} e digite ${b(approvals.codeFormatted)}.`);
    console.log(`   ${y('5.')} Reinicie as sessões do Claude Code que já estavam abertas.`);
    console.log('');
    console.log(`  ${d('Para testar sem gastar nada: toque em 🧪 no celular e escolha "Demo automático".')}`);
    console.log(`  ${d('Da próxima vez, basta')} ${b('npm start')} ${d('(ou dois cliques no arquivo ClawdDesk).')}`);
    console.log(`  ${d('Se o macOS perguntar se o "node" pode aceitar conexões de entrada, clique em Permitir.')}`);
  }
  console.log(`  ${d('Ctrl+C para encerrar.')}\n`);
  usage.start();
  fx.start();
  localSessions.start();
  web.start();
  link.start();
});

const shutdown = () => {
  console.log('\n  👋 ClawdDesk encerrado.');
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
