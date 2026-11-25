// Sessões do Claude Code abertas NESTE computador.
//
// O Claude Code mantém uma ficha por processo em ~/.claude/sessions/<pid>.json com o id da sessão,
// a pasta onde ela foi aberta, o título ("name"), se está ocupada ("busy"/"idle") e, quando a sessão
// também aparece no claude.ai (Controle Remoto), o id dela lá ("bridgeSessionId").
//
// Com isso o monitor mostra as sessões abertas mesmo antes de qualquer hook chegar (ex.: logo depois
// de reiniciar o ClawdDesk), dá nome a elas e evita mostrar em dobro as que também estão na web.
// Só leitura: nada aqui é alterado.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as cfg from './config.js';

const DIR = path.join(cfg.CLAUDE_DIR, 'sessions');
const POLL_MS = 5000;

// "session_01AbC…" (ficha local) e "cse_01AbC…" (API do claude.ai) são a mesma sessão
export const bridgeKey = (id) => String(id || '').replace(/^(session|cse)_/, '');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // existe, mas é de outro usuário
  }
}

export class LocalSessions extends EventEmitter {
  constructor() {
    super();
    this.list = new Map(); // sessionId -> { pid, sessionId, cwd, name, status, bridgeId, entrypoint, updatedAt }
    this.sig = '';
    this.timer = null;
  }

  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), POLL_MS);
    this.timer.unref();
    try {
      let t = null;
      fs.watch(DIR, () => {
        clearTimeout(t);
        t = setTimeout(() => this.scan(), 300);
      });
    } catch {
      /* pasta ainda não existe: fica só na leitura periódica */
    }
  }

  scan() {
    let files;
    try {
      files = fs.readdirSync(DIR).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      return; // pasta inexistente (Claude Code antigo) ou inacessível agora: mantém o que já sabia
    }
    const next = new Map();
    for (const f of files) {
      let o;
      try {
        o = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      } catch {
        continue;
      }
      const pid = Number(o.pid) || Number(f.split('.')[0]);
      if (!o.sessionId || !pid || !alive(pid)) continue;
      next.set(o.sessionId, {
        pid,
        sessionId: o.sessionId,
        cwd: typeof o.cwd === 'string' ? o.cwd : null,
        name: typeof o.name === 'string' ? o.name.slice(0, 120) : null,
        status: o.status === 'busy' ? 'busy' : 'idle',
        bridgeId: o.bridgeSessionId ? bridgeKey(o.bridgeSessionId) : null,
        entrypoint: o.entrypoint || null,
        updatedAt: Number(o.statusUpdatedAt || o.updatedAt) || 0,
      });
    }
    const sig = JSON.stringify([...next.values()]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.list = next;
    this.emit('change');
  }

  get(sessionId) {
    return this.list.get(sessionId) || null;
  }

  // ids (sem prefixo) das sessões deste PC que também aparecem no claude.ai
  bridgeIds() {
    return [...this.list.values()].map((x) => x.bridgeId).filter(Boolean);
  }
}
