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
    usage: usage.view(),
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
const localOnly = (req, res, next) =>
  LOCAL.has(req.socket.remoteAddress) ? next() : res.status(403).json({ error: 'permitido apenas a partir do próprio PC' });

const app = express();
app.disable('x-powered-by');

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
  // pedido de OUTRO PC (modo satélite): repassa a resposta para ele
  if (typeof id === 'string' && id.startsWith('sat:')) {
    if (!approvals.verify(token)) return res.status(401).json({ ok: false, error: 'aparelho não pareado' });
    if (decision !== 'allow' && decision !== 'deny') return res.status(400).json({ ok: false, error: 'decisão inválida' });
    const r = await hub.decide(id, decision);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    if (r.item) logLine(`📱 ${r.item.project} (${r.host}): ${decision === 'allow' ? 'PERMITIDO' : 'NEGADO'} pelo celular · ${r.item.tool.name} ${r.item.tool.target}`);
    return res.json({ ok: true });
  }
  if (typeof id === 'string' && id.startsWith('sim-')) {
    if (!approvals.verify(token)) return res.status(401).json({ ok: false, error: 'aparelho não pareado' });
    const ok = sim.remoteDecide(id, decision);
    return res.status(ok ? 200 : 410).json(ok ? { ok: true } : { ok: false, error: 'esse pedido já foi respondido ou expirou' });
  }
  const r = approvals.decide(String(id || ''), decision, token);
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
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const r = approvals.pair(req.body && req.body.code, req.body && req.body.label, ip);
  if (!cfg.QUIET) {
    const t = new Date().toTimeString().slice(0, 8);
    console.log(r.ok ? `  [${t}] 🔐 Aparelho pareado (${ip}) — já pode aprovar pedidos pelo celular` : `  [${t}] 🔐 Tentativa de pareamento recusada (${ip}): ${r.error}`);
  }
  res.status(r.ok ? 200 : 403).json(r);
});
app.post('/api/unpair', express.json({ limit: '2kb' }), (req, res) => res.json({ ok: approvals.unpair(req.body && req.body.token) }));
app.get('/api/pair/code', localOnly, (req, res) => res.json({ code: approvals.codeFormatted, paired: approvals.devices.length }));

app.post('/api/statusline', localOnly, express.json({ limit: '2mb' }), (req, res) => {
  try {
    store.handleStatusline(req.body || {});
  } catch (e) {
    console.error('  ⚠ statusLine inválido:', e.message);
  }
  res.status(204).end();
});

app.get('/api/state', (req, res) => res.json(snapshot()));

app.post('/api/simulate', express.json({ limit: '10kb' }), (req, res) => {
  const ok = sim.run(String((req.body && req.body.scenario) || ''));
  res.status(ok ? 200 : 400).json({ ok, sim: sim.view() });
});

let qrSvgCache = null;
app.get('/api/info', async (req, res) => {
  const lan = lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${cfg.PORT}` }));
  if (!qrSvgCache && lan[0]) {
    qrSvgCache = await QRCode.toString(lan[0].url, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
  }
  res.json({ port: cfg.PORT, lan, qrSvg: qrSvgCache, hooksInstalled: hooksInstalled() });
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
  const who = `${i.self ? '💻' : '📱'} ${i.device} ${i.ip}`;
  if (what === 'desconectado') return console.log(`  [${t}] ${who} desconectado`);
  const status = !i.version
    ? '⚠  versão ANTIGA — recarregue a página uma vez (⋮ → ↻); depois ela se atualiza sozinha'
    : i.version === uiVersion
      ? 'versão atual ✓'
      : 'versão anterior — atualizando sozinho…';
  console.log(`  [${t}] ${who} conectado · ${status}`);
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const self = ip === '127.0.0.1' || ip === '::1' || lanAddresses().some((a) => a.address === ip);
  ws.info = { ip, self, device: self ? 'este PC' : deviceOf(req.headers['user-agent']), connectedAt: Date.now(), version: null };
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (m) => {
    const txt = String(m);
    if (txt === 'ping') return ws.send('{"type":"pong"}');
    let msg;
    try {
      msg = JSON.parse(txt);
    } catch {
      return;
    }
    if (msg && msg.type === 'hello' && typeof msg.version === 'string') {
      const changed = ws.info.version !== msg.version.slice(0, 40);
      ws.info.version = msg.version.slice(0, 40);
      ws.info.paired = !!approvals.verify(msg.token);
      ws.send(JSON.stringify({ type: 'auth', paired: ws.info.paired }));
      if (changed) logClient(ws, 'conectado');
      hub.broadcastStatus(phonesOnline());
    }
    // outro computador (modo satélite)
    else if (msg && msg.type === 'satellite-hello') {
      clearTimeout(ws.helloTimer);
      hub.hello(ws, msg);
      if (ws.sat) hub.broadcastStatus(phonesOnline());
    } else if (msg && msg.type === 'satellite-state' && ws.sat) hub.state(ws, msg);
    else if (msg && msg.type === 'decision-result' && ws.sat) hub.result(msg);
  });
  // interfaces antigas não mandam "hello": depois de 6 s sem resposta, avisa que precisa recarregar
  ws.helloTimer = setTimeout(() => {
    if (!ws.info.version) logClient(ws, 'conectado');
  }, 6000);
  ws.on('close', () => {
    clearTimeout(ws.helloTimer);
    if (ws.sat) return hub.closed(ws);
    if (ws.info.logged) logClient(ws, 'desconectado');
    hub.broadcastStatus(phonesOnline());
  });
  ws.send(JSON.stringify({ type: 'snapshot', data: snapshot() }));
});

app.get('/api/clients', (req, res) =>
  res.json(
    [...wss.clients].filter((c) => !c.sat).map((c) => ({
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
    const viewers = [...wss.clients].filter((ws) => ws.readyState === 1 && !ws.sat);
    if (!viewers.length) return;
    const msg = JSON.stringify({ type: 'snapshot', data: snapshot() });
    for (const ws of viewers) ws.send(msg);
  }, 80);
}
// há celular pareado olhando? (satélites não contam)
const phonesOnline = () => [...wss.clients].some((c) => c.readyState === 1 && !c.sat && c.info && c.info.paired);
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
web.isWatched = () => [...wss.clients].some((c) => c.readyState === 1 && !c.sat);
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

server.listen(cfg.PORT, cfg.HOST, async () => {
  const lan = lanAddresses();
  const phoneUrl = lan[0] ? `http://${lan[0].address}:${cfg.PORT}` : null;
  const b = (s) => `\x1b[1m${s}\x1b[0m`;
  const c = (s) => `\x1b[36m${s}\x1b[0m`;
  const d = (s) => `\x1b[2m${s}\x1b[0m`;
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
    console.log(`   ${y('4.')} ${d('Opcional:')} para aprovar pedidos pelo celular, toque em ${b('🧪 → Parear / gerenciar')} e digite ${b(approvals.codeFormatted)}.`);
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
