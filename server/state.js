// Máquina de estados das sessões do Claude Code, alimentada pelos hooks e pelo statusLine.
// Estados: idle (aguardando) · thinking (trabalhando) · permission (precisa de você) · done (concluído)
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { prettyModel } from './pricing.js';
import { QUIET } from './config.js';

const DONE_HOLD_MS = 12e3; // quanto tempo o "concluído" fica na tela antes de voltar ao idle
const PERMISSION_STALE_MS = 10 * 60e3; // sem resposta em 10 min → desiste do alerta
const THINKING_STALE_MS = 30 * 60e3; // nenhum evento em 30 min → considera parado
const SESSION_TTL_MS = 6 * 3600e3;

const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const PERMISSION_NOTIFS = new Set([
  'permission_prompt',
  'worker_permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);
const PRIORITY = { permission: 3, thinking: 2, done: 1, idle: 0 };

const short = (s, n = 60) => {
  if (s == null) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// Texto do pedido para a tela: comandos digitados com "!" e slash commands chegam embrulhados em
// tags (<bash-input>, <command-name>…). Mostra "$ comando" / "/comando args" em vez das tags.
// (o hook corta o texto em 500 caracteres, então a tag de fechamento pode faltar)
function promptText(raw) {
  if (raw == null) return '';
  let t = String(raw).replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, ' ');
  const bash = t.match(/<bash-input>([\s\S]*?)(?:<\/bash-input>|$)/);
  if (bash) return `$ ${bash[1].trim()}`;
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)(?:<\/command-args>|$)/);
    return `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  t = t.replace(/<(bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>[\s\S]*?(<\/\1>|$)/g, ' ');
  return t;
}
const base = (p) => (p ? path.basename(String(p)) : '');
const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return short(u, 40);
  }
};

export function describeTool(name = '', i = {}) {
  i = i || {};
  switch (name) {
    case 'Read':
      return { name, icon: '📖', verb: 'Lendo', target: base(i.file_path) };
    case 'Edit':
    case 'MultiEdit':
      return { name, icon: '✏️', verb: 'Editando', target: base(i.file_path) };
    case 'Write':
      return { name, icon: '📝', verb: 'Escrevendo', target: base(i.file_path) };
    case 'NotebookEdit':
      return { name, icon: '📓', verb: 'Editando', target: base(i.notebook_path) };
    case 'Bash':
    case 'PowerShell':
      return { name, icon: '⌨️', verb: 'Executando', target: short(i.description || i.command, 56) };
    case 'Grep':
      return { name, icon: '🔎', verb: 'Buscando', target: `"${short(i.pattern, 36)}"` };
    case 'Glob':
      return { name, icon: '🗂️', verb: 'Procurando', target: short(i.pattern, 40) };
    case 'WebFetch':
      return { name, icon: '🌐', verb: 'Abrindo', target: host(i.url) };
    case 'WebSearch':
      return { name, icon: '🌐', verb: 'Pesquisando', target: short(i.query, 44) };
    case 'Task':
    case 'Agent':
      return { name, icon: '🤖', verb: 'Subagente', target: short(i.description || i.subagent_type, 44) };
    case 'TodoWrite':
      return { name, icon: '✅', verb: 'Atualizando', target: 'lista de tarefas' };
    case 'AskUserQuestion':
      return { name, icon: '❓', verb: 'Pergunta', target: short(i.question, 56) };
    case 'ExitPlanMode':
      return { name, icon: '📋', verb: 'Plano pronto', target: 'aguardando aprovação' };
    case 'Skill':
      return { name, icon: '🧩', verb: 'Skill', target: short(i.skill || i.command, 40) };
    case 'mcp__ccd_turn__wrap_up':
      return { name, icon: '📝', verb: 'Resumindo', target: 'a resposta' };
    case 'mcp__ccd_turn__update_plan':
      return { name, icon: '🗂️', verb: 'Atualizando', target: 'lista de tarefas' };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return { name, icon: '🔌', verb: short(server, 20), target: short(tool, 36) };
      }
      return { name, icon: '🛠️', verb: name || 'Ferramenta', target: '' };
  }
}

// Pergunta no fim da resposta (sessões do terminal): última frase terminando em "?".
export function questionFromText(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/[\s*_`>)\]"'”’]+$/u, '').trim();
  if (!t.endsWith('?')) return null;
  const parts = t.split(/(?<=[.!?\n])\s+/);
  const q = parts[parts.length - 1].replace(/^[\s*_#>\-–•]+/, '').trim();
  return q.length >= 6 ? short(q, 220) : null;
}

const sigOf = (name, i = {}) =>
  `${name}|${(i && (i.command || i.file_path || i.notebook_path || i.url || i.pattern || i.query || i.question)) || ''}`;

export class SessionStore extends EventEmitter {
  constructor(usage) {
    super();
    this.usage = usage;
    this.sessions = new Map();
    this.hooks = { lastAt: null, count: 0 };
    this.statusline = { lastAt: null };
    this.git = null; // GitTracker (definido pelo index.js)
    this.colors = null; // ColorRegistry (definido pelo index.js)
    setInterval(() => this.tick(), 1000).unref();
  }

  get(id, p = {}) {
    let s = this.sessions.get(id);
    const now = Date.now();
    if (!s) {
      s = {
        id,
        cwd: null,
        state: 'idle',
        since: now,
        lastEventAt: now,
        aliveAt: now,
        lastTs: 0,
        tool: null,
        prompt: null,
        message: null,
        pending: null,
        turnStart: null,
        toolCount: 0,
        lastDone: null,
        recent: [], // últimos passos da sessão (pedido, ferramentas, permissões, conclusão)
        question: null, // pergunta esperando sua resposta { text, options, at, source }
        firstSeen: now,
        model: null,
        ctxStatus: null,
        costStatus: null,
        transcriptPath: null,
        name: null,
      };
      this.sessions.set(id, s);
    }
    const cwd = p.cwd || (p.workspace && (p.workspace.project_dir || p.workspace.current_dir));
    if (cwd) s.cwd = cwd;
    if (p.transcript_path) s.transcriptPath = p.transcript_path;
    if (p.workspace && p.workspace.project_dir) s.root = p.workspace.project_dir;
    else if (cwd || p.transcript_path) s.root = projectRoot(s.cwd, s.transcriptPath) || s.root || s.cwd;
    s.aliveAt = now;
    return s;
  }

  pushRecent(s, ev) {
    const last = s.recent[s.recent.length - 1];
    if (last && last.verb === ev.verb && last.target === ev.target && Date.now() - last.ts < 1500) return;
    s.recent.push({ ts: Date.now(), icon: ev.icon, verb: ev.verb, target: ev.target || '', kind: ev.kind || 'tool' });
    if (s.recent.length > 10) s.recent.shift();
  }

  setState(s, state) {
    if (s.state === state) return;
    const prev = s.state;
    s.state = state;
    s.since = Date.now();
    if (!QUIET) {
      const t = new Date().toTimeString().slice(0, 8);
      const what = state === 'thinking' && s.tool ? `${s.tool.verb} ${s.tool.target}` : s.message || '';
      console.log(`  [${t}] ${projectName(s)}: ${prev} → ${state}${what ? '  ' + short(what, 70) : ''}`);
    }
  }

  handleHook(p) {
    const ev = p && p.hook_event_name;
    if (!ev) return;
    const now = Date.now();
    this.hooks.lastAt = now;
    this.hooks.count++;
    const id = p.session_id || 'default';
    if (ev === 'SessionEnd') {
      this.sessions.delete(id);
      this.emit('change');
      return;
    }
    const s = this.get(id, p);
    const ts = Number(p._ts) || now;
    const stale = ts < s.lastTs; // hooks assíncronos podem chegar fora de ordem
    if (!stale) s.lastTs = ts;
    s.lastEventAt = now;

    switch (ev) {
      case 'SessionStart':
        s.pending = null;
        s.message = null;
        s.question = null;
        if (!stale) this.setState(s, 'idle');
        break;
      case 'UserPromptSubmit':
        s.prompt = short(promptText(p.prompt), 160) || s.prompt;
        s.question = null; // você respondeu
        this.pushRecent(s, { icon: '💬', verb: 'Pedido', target: short(promptText(p.prompt), 90), kind: 'prompt' });
        s.turnStart = ts;
        s.toolCount = 0;
        s.tool = null;
        s.message = null;
        s.pending = null;
        if (!stale) this.setState(s, 'thinking');
        break;
      case 'PreToolUse': {
        s.toolCount++;
        s.tool = describeTool(p.tool_name, p.tool_input);
        this.pushRecent(s, s.tool);
        {
          const i = p.tool_input || {};
          if (p.tool_name === 'AskUserQuestion' && i.question) s.question = { text: short(i.question, 220), options: i.options || [], at: Date.now(), source: 'ask' };
          else if (/wrap_up$/.test(p.tool_name || '') && i.ask) s.question = { text: short(i.ask, 220), options: i.options || [], at: Date.now(), source: 'app' };
        }
        if (stale) break;
        if (WAIT_TOOLS.has(p.tool_name)) {
          s.pending = { sig: sigOf(p.tool_name, p.tool_input), ts };
          s.message = p.tool_name === 'ExitPlanMode' ? 'Plano aguardando aprovação' : 'Claude tem uma pergunta';
          this.setState(s, 'permission');
        } else if (s.pending && ts - s.pending.ts < 2000) {
          // ferramentas em paralelo enquanto a permissão está aberta: mantém o alerta
        } else {
          s.pending = null;
          this.setState(s, 'thinking');
        }
        break;
      }
      case 'PermissionRequest':
        s.tool = describeTool(p.tool_name, p.tool_input);
        if (!WAIT_TOOLS.has(p.tool_name)) this.pushRecent(s, { icon: '✋', verb: 'Permissão', target: `${p.tool_name}: ${s.tool.target}`, kind: 'alert' });
        s.pending = { sig: sigOf(p.tool_name, p.tool_input), ts };
        s.message = WAIT_TOOLS.has(p.tool_name)
          ? s.message || 'Claude tem uma pergunta'
          : `Permitir ${p.tool_name || 'ferramenta'}?`;
        if (!stale) this.setState(s, 'permission');
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (ev === 'PostToolUseFailure') this.pushRecent(s, { icon: '✖', verb: 'Falhou', target: p.tool_name || 'ferramenta', kind: 'error' });
        if (stale) break;
        if (s.pending && s.pending.sig && s.pending.sig !== sigOf(p.tool_name, p.tool_input)) break;
        s.pending = null;
        s.message = null;
        this.setState(s, 'thinking');
        break;
      case 'PreCompact':
        s.tool = { name: 'compact', icon: '🗜️', verb: 'Compactando', target: 'contexto' };
        this.pushRecent(s, s.tool);
        if (!stale) this.setState(s, 'thinking');
        break;
      case 'Notification':
        this.onNotification(s, p, stale);
        break;
      case 'Stop':
      case 'StopFailure':
        // sessões do terminal: a resposta terminou com uma pergunta?
        if (!(s.question && s.turnStart && s.question.at >= s.turnStart)) {
          const q = questionFromText(p.last_assistant_message);
          s.question = q ? { text: q, options: [], at: Date.now(), source: 'text' } : null;
        }
        if (!stale) {
          s.lastDone = {
            at: now,
            duration: s.turnStart ? ts - s.turnStart : null,
            tools: s.toolCount,
            error: ev === 'StopFailure',
          };
          s.tool = null;
          s.pending = null;
          s.message = ev === 'StopFailure' ? 'Parou com erro da API' : null;
          this.pushRecent(
            s,
            ev === 'StopFailure'
              ? { icon: '⚠️', verb: 'Erro', target: 'a API falhou', kind: 'error' }
              : { icon: '✅', verb: 'Concluído', target: `${s.toolCount} ${s.toolCount === 1 ? 'ferramenta' : 'ferramentas'}`, kind: 'done' }
          );
          this.setState(s, 'done');
        }
        this.usage.requestOAuthSoon();
        break;
      default:
        break;
    }
    if (s.transcriptPath && (ev === 'Stop' || ev === 'PostToolUse' || ev === 'UserPromptSubmit' || ev === 'SessionStart')) {
      this.usage.refreshFile(s.transcriptPath);
    }
    this.emit('change');
  }

  // Resposta dada pelo celular: registra no histórico e volta a sessão para "trabalhando".
  remoteDecision(sessionId, decision, tool) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.pending = null;
    s.message = null;
    this.pushRecent(s, {
      icon: '📱',
      verb: decision === 'allow' ? 'Permitido pelo celular' : 'Negado pelo celular',
      target: tool ? `${tool.name}: ${tool.target}` : '',
      kind: decision === 'allow' ? 'done' : 'error',
    });
    s.lastEventAt = Date.now();
    this.setState(s, 'thinking');
    this.emit('change');
  }

  onNotification(s, p, stale) {
    const type = p.notification_type || '';
    const msg = p.message || '';
    if (PERMISSION_NOTIFS.has(type) || (!type && /permission|permiss/i.test(msg))) {
      if (!s.pending) {
        s.pending = { sig: null, ts: Number(p._ts) || Date.now() };
        this.pushRecent(s, { icon: '✋', verb: 'Aguardando', target: short(msg, 80) || 'sua aprovação', kind: 'alert' });
      }
      s.message = short(msg, 80) || 'Aguardando sua aprovação';
      if (!stale) this.setState(s, 'permission');
    } else if (type === 'idle_prompt' || (!type && /waiting for your input/i.test(msg))) {
      if (s.state === 'done' || s.state === 'idle') {
        s.message = null;
        this.setState(s, 'idle');
      }
    }
  }

  handleStatusline(p) {
    if (!p || typeof p !== 'object') return;
    const now = Date.now();
    this.statusline.lastAt = now;
    const s = this.get(p.session_id || 'default', p);
    if (p.model) s.model = { id: p.model.id || null, name: p.model.display_name || prettyModel(p.model.id) };
    if (p.session_name) s.name = p.session_name;
    const cw = p.context_window;
    if (cw && (cw.used_percentage != null || cw.total_input_tokens != null)) {
      const size = cw.context_window_size || null;
      const used =
        cw.total_input_tokens ??
        (cw.current_usage
          ? (cw.current_usage.input_tokens || 0) +
            (cw.current_usage.cache_creation_input_tokens || 0) +
            (cw.current_usage.cache_read_input_tokens || 0)
          : null);
      const pct = cw.used_percentage ?? (used != null && size ? (used / size) * 100 : null);
      s.ctxStatus = { used, size, pct, at: now };
    }
    if (p.cost && typeof p.cost.total_cost_usd === 'number') s.costStatus = p.cost.total_cost_usd;
    this.usage.applyStatusline(p.rate_limits);
    this.emit('change');
  }

  // Sessões abertas neste PC (fichas em ~/.claude/sessions): garante que todas apareçam, com o
  // título, mesmo sem hook recente; e tira da lista as que foram fechadas.
  syncLocal(reg) {
    const now = Date.now();
    let changed = false;
    for (const info of reg.list.values()) {
      let s = this.sessions.get(info.sessionId);
      if (!s) {
        s = this.get(info.sessionId, { cwd: info.cwd });
        s.lastEventAt = info.updatedAt || now;
        s.since = s.lastEventAt;
        changed = true;
      }
      if (info.cwd) s.root = info.cwd; // pasta onde a sessão foi aberta = o projeto
      if (!s.local || s.local.name !== info.name || s.local.status !== info.status) changed = true;
      s.local = info;
      s.aliveAt = now;
      // sem hooks recentes (ex.: ClawdDesk acabou de abrir), usa o "ocupada/livre" da ficha
      const quiet = now - s.lastEventAt > 20e3;
      if (quiet && info.status === 'busy' && s.state === 'idle') {
        s.turnStart = s.turnStart || info.updatedAt || now;
        this.setState(s, 'thinking');
        changed = true;
      } else if (quiet && info.status === 'idle' && s.state === 'thinking') {
        this.setState(s, 'idle');
        changed = true;
      }
    }
    // processo encerrado: a sessão foi fechada
    for (const s of [...this.sessions.values()]) {
      if (s.local && !reg.list.has(s.id)) {
        this.sessions.delete(s.id);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  tick() {
    const now = Date.now();
    let changed = false;
    for (const s of this.sessions.values()) {
      const quiet = now - s.lastEventAt;
      if (s.state === 'done' && now - s.since > DONE_HOLD_MS) {
        this.setState(s, 'idle');
        changed = true;
      } else if (s.state === 'permission' && quiet > PERMISSION_STALE_MS) {
        s.pending = null;
        s.message = null;
        this.setState(s, 'idle');
        changed = true;
      } else if (s.state === 'thinking' && quiet > THINKING_STALE_MS) {
        this.setState(s, 'idle');
        changed = true;
      } else if (s.state === 'idle' && !s.local && now - s.aliveAt > SESSION_TTL_MS) {
        // (sessões com ficha em ~/.claude/sessions saem quando o processo termina, em syncLocal)
        this.sessions.delete(s.id);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  view(s) {
    const m = this.usage.sessionMetrics(s.id);
    // pasta do projeto em ~/.claude/projects: a do transcript, ou o cwd codificado como o Claude Code faz
    const projectKey = s.transcriptPath
      ? path.basename(path.dirname(s.transcriptPath))
      : s.cwd
        ? s.cwd.replace(/[^a-zA-Z0-9]/g, '-')
        : null;
    this.usage.ensureProject(projectKey);
    const now = Date.now();
    let context = null;
    if (s.ctxStatus && now - s.ctxStatus.at < 15 * 60e3 && s.ctxStatus.pct != null) context = s.ctxStatus;
    else if (m && m.context) context = m.context;
    return {
      id: s.id,
      project: projectName(s, m),
      name: s.name || (s.local && s.local.name) || null,
      origin: null, // null = este PC; satélites e web preenchem { kind, label }
      bridgeId: s.local ? s.local.bridgeId : null,
      state: s.state,
      since: s.since,
      lastEventAt: s.lastEventAt,
      tool: s.tool,
      prompt: s.prompt,
      message: s.message,
      toolCount: s.toolCount,
      question: s.question,
      recent: s.recent.slice(-8),
      firstSeen: s.firstSeen,
      turnStart: s.turnStart,
      lastDone: s.lastDone,
      model: (s.model && s.model.name) || prettyModel(m && m.model) || null,
      context: context ? { used: context.used, size: context.size, pct: context.pct } : null,
      cost: s.costStatus ?? (m ? m.cost : null),
      tokens: m ? { total: m.tokens, input: m.input, output: m.output } : null,
      work: this.usage.workView(s.id, projectKey),
      git: this.git && s.cwd ? this.git.get(s.cwd) : null,
      colorIndex: this.colors ? this.colors.get(projectName(s, m)) : 0,
      pr: this.usage.prFor(s.id),
    };
  }

  list() {
    return [...this.sessions.values()]
      .map((s) => this.view(s))
      .sort((a, b) => PRIORITY[b.state] - PRIORITY[a.state] || b.lastEventAt - a.lastEventAt);
  }
}

function projectName(s, m) {
  const cwd = s.root || s.cwd || (m && m.cwd);
  if (!cwd) return 'Claude Code';
  const n = path.basename(cwd);
  // pastas de rascunho do app Claude (mesmo nome usado na linha do tempo)
  return /^scratch-\d{4}-\d{2}-\d{2}/.test(n) ? 'rascunho (app)' : n;
}

// Pasta onde a sessão foi aberta. O "cwd" dos hooks acompanha os "cd" do Claude (ex.: loja-online/
// docs/posts), mas o projeto é a pasta de início, que o Claude Code codifica no nome da pasta do
// transcript (~/.claude/projects/-Users-voce-code-loja-online/…). Sobe a partir do cwd até achar ela.
const encodeDir = (d) => String(d).replace(/[^a-zA-Z0-9]/g, '-');
function projectRoot(cwd, transcriptPath) {
  if (!cwd) return null;
  if (!transcriptPath) return cwd;
  const key = path.basename(path.dirname(String(transcriptPath)));
  for (let d = String(cwd); ; ) {
    if (encodeDir(d) === key) return d;
    const up = path.dirname(d);
    if (up === d) return null; // fora da pasta do projeto (ex.: "cd /tmp"): mantém o nome que já tinha
    d = up;
  }
}
