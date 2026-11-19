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

const usage = new UsageTracker();
const store = new SessionStore(usage);
const sim = new Simulator();
const approvals = new Approvals();
const gitTracker = new GitTracker();
store.git = gitTracker;
const colors = new ColorRegistry();
const fx = new FxRate();
store.colors = colors;

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
  const sessions = store.list();
  const base = {
    serverTime: Date.now(),
    primary: sessions[0] || null,
    sessions: sessions.slice(0, 8),
    usage: usage.view(),
    hooks: store.hooks,
    statusline: store.statusline,
    sim: { active: false },
    version: uiVersion,
    approvals: approvals.view(),
    timeline: withColors(usage.timelineView()),
    fx: fx.view(),
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

app.post('/api/permission/decision', express.json({ limit: '10kb' }), (req, res) => {
  const { id, decision, token } = req.body || {};
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
    }
  });
  // interfaces antigas não mandam "hello": depois de 6 s sem resposta, avisa que precisa recarregar
  ws.helloTimer = setTimeout(() => {
    if (!ws.info.version) logClient(ws, 'conectado');
  }, 6000);
  ws.on('close', () => {
    clearTimeout(ws.helloTimer);
    if (ws.info.logged) logClient(ws, 'desconectado');
  });
  ws.send(JSON.stringify({ type: 'snapshot', data: snapshot() }));
});

app.get('/api/clients', (req, res) =>
  res.json(
    [...wss.clients].map((c) => ({
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
    const msg = JSON.stringify({ type: 'snapshot', data: snapshot() });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
  }, 80);
}
store.on('change', broadcast);
approvals.on('change', broadcast);
gitTracker.on('change', broadcast);
fx.on('change', broadcast);
approvals.onlineCheck = () => [...wss.clients].some((c) => c.readyState === 1 && c.info && c.info.paired);
usage.on('change', broadcast);
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
  console.log(
    `  🔐 Código para parear o celular (aprovar pedidos por ele): ${b(approvals.codeFormatted)}` +
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
});

const shutdown = () => {
  console.log('\n  👋 ClawdDesk encerrado.');
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
