// Modo "Simular estados": sobrepõe uma sessão falsa e números de uso fictícios ao estado real,
// para testar animações, sons e alertas sem gastar tokens. Expira sozinho após 3 min parado.
import { EventEmitter } from 'node:events';

const TOOLS = [
  { name: 'Read', icon: '📖', verb: 'Lendo', target: 'checkout.ts' },
  { name: 'Grep', icon: '🔎', verb: 'Buscando', target: '"calcularFrete"' },
  { name: 'Edit', icon: '✏️', verb: 'Editando', target: 'pagamentos.service.ts' },
  { name: 'Bash', icon: '⌨️', verb: 'Executando', target: 'npm test -- pagamentos' },
  { name: 'Write', icon: '📝', verb: 'Escrevendo', target: 'pagamentos.spec.ts' },
  { name: 'Task', icon: '🤖', verb: 'Subagente', target: 'Revisar casos de borda' },
];
const IDLE_TIMEOUT_MS = 3 * 60e3;
const PROMPT = 'Refatorar o módulo de pagamentos e cobrir com testes (simulação)';
const MIN = 60e3;

export class Simulator extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this.timers = [];
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.since = Date.now();
    this.tool = null;
    this.toolIdx = 0;
    this.toolCount = 0;
    this.message = null;
    this.lastDone = null;
    this.turnStart = null;
    this.recent = [];
    this.approval = null; // pedido fictício para testar Permitir/Negar pelo celular
    this.question = null; // pergunta fictícia ("aguardando você")
    this.usage = { five: 42, seven: 23, ctx: 38, fable: 12 };
  }

  openApproval() {
    const now = Date.now();
    this.approval = { id: `sim-${now}`, sessionId: 'sim', project: 'loja-online', tool: this.tool, mode: 'default', createdAt: now, expiresAt: now + 110e3 };
  }

  // Resposta do celular ao pedido fictício (mesmo fluxo de um pedido real).
  remoteDecide(id, decision) {
    if (!this.active || !this.approval || this.approval.id !== id) return false;
    const tool = this.approval.tool;
    this.approval = null;
    this.clearTimers();
    this.touch();
    this.push({
      icon: '📱',
      verb: decision === 'allow' ? 'Permitido pelo celular' : 'Negado pelo celular',
      target: tool ? `${tool.name}: ${tool.target}` : '',
      kind: decision === 'allow' ? 'done' : 'error',
    });
    if (decision === 'allow') this.startThinking();
    else this.set('idle', { tool: null, message: null });
    return true;
  }

  push(ev) {
    this.recent.push({ ts: Date.now(), kind: 'tool', ...ev });
    if (this.recent.length > 10) this.recent.shift();
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t), clearInterval(t);
    this.timers = [];
  }

  touch() {
    clearTimeout(this.expireTimer);
    this.expireTimer = setTimeout(() => this.run('stop'), IDLE_TIMEOUT_MS);
    this.expireTimer.unref?.();
  }

  set(state, extra = {}) {
    if (this.state !== state) this.since = Date.now();
    if (state !== 'permission') this.approval = null;
    this.state = state;
    Object.assign(this, extra);
    this.emit('change');
  }

  startThinking() {
    this.question = null;
    if (!this.turnStart) {
      this.turnStart = Date.now();
      this.push({ icon: '💬', verb: 'Pedido', target: PROMPT, kind: 'prompt' });
    }
    this.message = null;
    const step = () => {
      this.tool = TOOLS[this.toolIdx++ % TOOLS.length];
      this.toolCount++;
      this.push(this.tool);
      this.set('thinking');
    };
    step();
    this.timers.push(setInterval(step, 1700));
  }

  finish() {
    this.lastDone = { at: Date.now(), duration: Date.now() - (this.turnStart || Date.now() - 95e3), tools: this.toolCount || 9 };
    this.turnStart = null;
    this.tool = null;
    this.message = null;
    this.push({ icon: '✅', verb: 'Concluído', target: `${this.lastDone.tools} ferramentas`, kind: 'done' });
    this.set('done');
  }

  run(scenario) {
    const known = ['idle', 'thinking', 'permission', 'done', 'question', 'warning80', 'warning95', 'normal', 'demo', 'stop'];
    if (!known.includes(scenario)) return false;
    this.clearTimers();
    if (scenario === 'stop') {
      this.active = false;
      clearTimeout(this.expireTimer);
      this.reset();
      this.emit('change');
      return true;
    }
    if (!this.active) {
      this.active = true;
      this.reset();
    }
    this.touch();
    switch (scenario) {
      case 'idle':
        this.tool = null;
        this.message = null;
        this.set('idle');
        break;
      case 'thinking':
        this.startThinking();
        break;
      case 'permission':
        this.tool = { name: 'Bash', icon: '⌨️', verb: 'Executando', target: 'rm -rf dist && npm run build' };
        this.push({ icon: '✋', verb: 'Permissão', target: 'Bash: rm -rf dist && npm run build', kind: 'alert' });
        this.set('permission', { message: 'Permitir Bash?' });
        this.openApproval();
        this.emit('change');
        break;
      case 'done':
        this.toolCount = this.toolCount || 14;
        this.finish();
        break;
      case 'question':
        this.toolCount = this.toolCount || 14;
        this.finish();
        this.question = {
          text: 'Os testes passaram. Quer que eu publique a versão nova agora?',
          options: ['Publicar agora', 'Revisar antes'],
          at: Date.now(),
          source: 'app',
        };
        this.emit('change');
        break;
      case 'warning80':
        this.usage = { five: 83, seven: 64, ctx: 71, fable: 58 };
        this.emit('change');
        break;
      case 'warning95':
        this.usage = { five: 96, seven: 88, ctx: 92, fable: 97 };
        this.emit('change');
        break;
      case 'normal':
        this.usage = { five: 42, seven: 23, ctx: 38, fable: 12 };
        this.emit('change');
        break;
      case 'demo':
        this.demo();
        break;
    }
    return true;
  }

  demo() {
    this.usage = { five: 42, seven: 23, ctx: 38, fable: 12 };
    this.set('idle', { tool: null, message: null, toolCount: 0, turnStart: null });
    const at = (ms, fn) => this.timers.push(setTimeout(fn, ms));
    at(3000, () => this.startThinking());
    at(11000, () => {
      this.clearTimers();
      this.tool = { name: 'Bash', icon: '⌨️', verb: 'Executando', target: 'npm install stripe' };
      this.push({ icon: '✋', verb: 'Permissão', target: 'Bash: npm install stripe', kind: 'alert' });
      this.set('permission', { message: 'Permitir Bash?' });
      this.openApproval();
      this.emit('change');
      at(7000, () => {
        this.startThinking();
        at(6000, () => {
          this.clearTimers();
          this.finish();
          at(6000, () => {
            this.set('idle');
            this.usage = { five: 83, seven: 61, ctx: 74, fable: 55 };
            this.emit('change');
            at(6000, () => {
              this.usage = { five: 96, seven: 88, ctx: 90, fable: 97 };
              this.emit('change');
              at(6000, () => {
                this.usage = { five: 42, seven: 23, ctx: 38, fable: 12 };
                this.emit('change');
              });
            });
          });
        });
      });
    });
  }

  view() {
    return { active: this.active };
  }

  // Linha do tempo fictícia do dia (3 projetos).
  fakeTimeline(now) {
    const H = 3600e3;
    const d0 = new Date(now);
    d0.setHours(0, 0, 0, 0);
    const at = (h, m) => Math.min(now, d0.getTime() + h * H + m * 60e3);
    const proj = (name, ivs) => {
      const intervals = ivs.map(([a, b]) => [at(...a), at(...b)]).filter(([a, b]) => b > a);
      const colorIndex = { 'loja-online': 0, 'api-pagamentos': 3, 'site-institucional': 2 }[name] || 0;
      const p = { key: name, name, colorIndex, total: intervals.reduce((t, [a, b]) => t + b - a, 0), intervals };
      // api-pagamentos é trabalhado no "Notebook" (modo satélite)
      return name === 'api-pagamentos' ? { ...p, hosts: ['Notebook'], remoteOnly: true } : p;
    };
    const projects = [
      proj('loja-online', [[[8, 40], [9, 55]], [[10, 20], [11, 5]], [[13, 30], [15, 10]], [[15, 40], [24, 0]]]),
      proj('api-pagamentos', [[[9, 10], [9, 50]], [[11, 0], [12, 10]], [[14, 0], [14, 45]]]),
      proj('site-institucional', [[[7, 50], [8, 30]], [[12, 30], [13, 15]]]),
    ].filter((p) => p.total > 0);
    projects.sort((a, b) => b.total - a.total);
    return { dayStart: d0.getTime(), from: d0.getTime() + 7 * H, to: now, projects };
  }

  // Outras sessões fictícias, para ver o painel de várias sessões funcionando — uma delas vinda
  // de outro computador (modo satélite) e outra da web (claude.ai/code).
  fakeSessions(now) {
    const base = { name: null, message: null, lastEventAt: now, firstSeen: now - 3 * 3600e3 };
    return [
      {
        ...base,
        id: 'sim-2',
        origin: { kind: 'pc', label: 'Notebook', online: true },
        project: 'api-pagamentos',
        state: 'thinking',
        since: now - 6 * MIN,
        tool: { name: 'Bash', icon: '⌨️', verb: 'Executando', target: 'npm run test:e2e' },
        prompt: 'Corrigir os testes E2E do checkout',
        toolCount: 31,
        turnStart: now - 6 * MIN,
        lastDone: null,
        model: 'Sonnet 5.5',
        context: { used: 104000, size: 200000, pct: 52 },
        cost: 1.87,
        tokens: { total: 2_400_000 },
        colorIndex: 3,
        git: { branch: 'fix/checkout-e2e', files: 3, untracked: 0, added: 52, removed: 18 },
        pr: null,
        work: { session: { total: 6 * MIN, today: 6 * MIN }, project: { total: 14 * 60 * MIN + 20 * MIN, today: 71 * MIN, sessions: 5, first: now - 12 * 864e5 } },
        recent: [
          { ts: now - 70e3, icon: '🔎', verb: 'Buscando', target: '"checkout.spec"', kind: 'tool' },
          { ts: now - 40e3, icon: '✏️', verb: 'Editando', target: 'checkout.spec.ts', kind: 'tool' },
          { ts: now - 8e3, icon: '⌨️', verb: 'Executando', target: 'npm run test:e2e', kind: 'tool' },
        ],
      },
      {
        ...base,
        id: 'sim-3',
        project: 'site-institucional',
        state: 'idle',
        since: now - 14 * MIN,
        lastEventAt: now - 14 * MIN,
        tool: null,
        prompt: 'Ajustar o SEO das páginas de produto',
        toolCount: 12,
        turnStart: null,
        lastDone: { at: now - 14 * MIN, duration: 4 * MIN + 12e3, tools: 12 },
        model: 'Opus 5.5',
        context: { used: 220000, size: 1_000_000, pct: 22 },
        cost: 0.94,
        tokens: { total: 900_000 },
        colorIndex: 2,
        git: { branch: 'main', files: 0, untracked: 0, added: 0, removed: 0 },
        pr: { number: 57, url: 'https://github.com/exemplo/site-institucional/pull/57', repo: 'exemplo/site-institucional' },
        work: { session: { total: 4 * MIN, today: 4 * MIN }, project: { total: 3 * 60 * MIN + 5 * MIN, today: 4 * MIN, sessions: 2, first: now - 3 * 864e5 } },
        recent: [{ ts: now - 14 * MIN, icon: '✅', verb: 'Concluído', target: '12 ferramentas', kind: 'done' }],
      },
      {
        ...base,
        id: 'sim-4',
        origin: { kind: 'web', label: 'web' },
        project: 'app-mobile',
        name: 'Login com biometria',
        state: 'idle',
        since: now - 32 * MIN,
        lastEventAt: now - 32 * MIN,
        tool: null,
        prompt: null,
        message: 'Login por biometria pronto; PR aberto para revisão',
        toolCount: 0,
        turnStart: null,
        lastDone: { at: now - 32 * MIN, duration: null, tools: null },
        model: 'Opus 5.5',
        context: { used: 310000, size: 1_000_000, pct: 31 },
        cost: 2.61,
        tokens: null,
        colorIndex: 5,
        git: { branch: 'claude/login-biometria', files: null },
        pr: null,
        work: null,
        recent: [],
      },
    ];
  }

  // Aplica a simulação sobre um snapshot real.
  apply(snap) {
    if (!this.active) return snap;
    const now = Date.now();
    const sim = {
      id: 'sim',
      project: 'loja-online',
      name: null,
      state: this.state,
      since: this.since,
      lastEventAt: now,
      tool: this.tool,
      prompt: PROMPT,
      question: this.question,
      colorIndex: 0,
      git: { branch: 'feat/pagamentos-pix', files: 7, untracked: 2, added: 184, removed: 41 },
      pr: { number: 128, url: 'https://github.com/exemplo/loja-online/pull/128', repo: 'exemplo/loja-online' },
      work: { session: { total: 48 * MIN, today: 48 * MIN }, project: { total: 37 * 60 * MIN + 12 * MIN, today: 133 * MIN, sessions: 9, first: now - 23 * 864e5 } },
      recent: this.recent.slice(-8),
      firstSeen: now - 40 * MIN,
      message: this.message,
      toolCount: this.toolCount,
      turnStart: this.turnStart,
      lastDone: this.lastDone,
      model: 'Opus 5.5',
      context: { used: Math.round(this.usage.ctx * 10000), size: 1_000_000, pct: this.usage.ctx },
      cost: 3.42,
      tokens: { total: 1_840_000, input: 1_700_000, output: 140_000 },
    };
    return {
      ...snap,
      primary: sim,
      sessions: [sim, ...this.fakeSessions(now)].slice(0, 8),
      usage: {
        ...snap.usage,
        fiveHour: { pct: this.usage.five, resetsAt: now + 72 * MIN, source: 'simulação' },
        sevenDay: { pct: this.usage.seven, resetsAt: now + (3 * 24 * 60 + 260) * MIN, source: 'simulação' },
        models: [
          {
            name: 'Fable',
            pct: this.usage.fable,
            allowance: 50,
            shareOfWeekly: Math.min(this.usage.seven, this.usage.fable / 2),
            resetsAt: now + (3 * 24 * 60 + 260) * MIN,
          },
        ],
      },
      sim: { active: true },
      timeline: this.fakeTimeline(now),
      approvals: {
        ...(snap.approvals || { pairedDevices: 0, open: [] }),
        open: [...(this.approval ? [this.approval] : []), ...((snap.approvals && snap.approvals.open) || [])],
      },
    };
  }
}
