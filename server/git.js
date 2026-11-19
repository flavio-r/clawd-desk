// Git por sessão: branch, arquivos alterados e linhas (+/−) da pasta de cada sessão.
// Só leitura (status/diff), com GIT_OPTIONAL_LOCKS=0 para nunca disputar o index com você.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

const FRESH_MS = 60e3; // atualiza sozinho a cada minuto
const NOT_REPO_RETRY_MS = 5 * 60e3;

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 4000, maxBuffer: 4 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout) => resolve(err ? null : String(stdout))
    );
  });
}

export class GitTracker extends EventEmitter {
  constructor() {
    super();
    this.cache = new Map(); // cwd -> { at, data, running, timer }
  }

  // Devolve o último valor conhecido e agenda atualização se estiver velho.
  get(cwd) {
    if (!cwd) return null;
    const c = this.cache.get(cwd);
    const age = c ? Date.now() - c.at : Infinity;
    if (!c || age > (c.data ? FRESH_MS : NOT_REPO_RETRY_MS)) this.refresh(cwd);
    return c ? c.data : null;
  }

  // Atualização com espera curta (vários eventos seguidos viram uma leitura só).
  refresh(cwd, delay = 1500) {
    if (!cwd) return;
    let c = this.cache.get(cwd);
    if (!c) {
      c = { at: 0, data: null, running: false, timer: null };
      this.cache.set(cwd, c);
    }
    if (c.timer || c.running) return;
    c.timer = setTimeout(() => {
      c.timer = null;
      this.read(cwd, c);
    }, delay);
  }

  async read(cwd, c) {
    c.running = true;
    try {
      const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (head == null) {
        c.data = null; // não é um repositório git
        return;
      }
      let branch = head.trim();
      if (branch === 'HEAD') branch = ((await git(cwd, ['rev-parse', '--short', 'HEAD'])) || 'detached').trim();
      const status = (await git(cwd, ['status', '--porcelain=v1'])) || '';
      const lines = status.split('\n').filter(Boolean);
      const untracked = lines.filter((l) => l.startsWith('??')).length;
      let diff = await git(cwd, ['diff', 'HEAD', '--numstat']);
      if (diff == null) diff = (await git(cwd, ['diff', '--numstat'])) || ''; // repositório sem commits
      let added = 0;
      let removed = 0;
      for (const l of diff.split('\n')) {
        const [a, r] = l.split('\t');
        if (/^\d+$/.test(a)) added += Number(a);
        if (/^\d+$/.test(r)) removed += Number(r);
      }
      const data = { branch, files: lines.length, untracked, added, removed };
      const changed = JSON.stringify(data) !== JSON.stringify(c.data);
      c.data = data;
      if (changed) this.emit('change');
    } finally {
      c.at = Date.now();
      c.running = false;
    }
  }
}
