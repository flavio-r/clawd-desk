// Login com usuário e senha.
//
// Liga sozinho no modo servidor (CLAWDDESK_MODE=server) e, no modo local, quando existe pelo menos
// um usuário criado (npm run user -- add NOME). Sem usuários, o modo local continua aberto para a
// rede Wi-Fi, como sempre foi.
//
// O que fica guardado em data/:
//   users.json          { users: [{ name, hash, createdAt, pwdAt }] }   senha só como hash scrypt
//   auth-sessions.json  { sessions: [{ hash, user, createdAt, lastSeen, ua }] }   cookie só como hash
//
// Todo acesso confere se o usuário ainda existe e se a senha não foi trocada depois do login:
// remover o usuário ou trocar a senha derruba os aparelhos logados na hora.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cfg from './config.js';

export const USERS_FILE = path.join(cfg.DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(cfg.DATA_DIR, 'auth-sessions.json');
export const COOKIE = 'cd_session';
const DAY = 864e5;
const TTL = cfg.LOGIN_DAYS * DAY;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const MIN_PASSWORD = 8;
export const validName = (n) => /^[a-z0-9][a-z0-9._-]{1,31}$/.test(String(n || ''));

// ---------------------------------------------------------------- senhas (scrypt)
const SCRYPT = { N: 16384, r: 8, p: 1 };
function scrypt(password, salt, opts) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password).normalize('NFKC'), salt, 64, { ...opts, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k)))
  );
}
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function checkPassword(password, stored) {
  const [alg, N, r, p, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// hash de mentira, para gastar o mesmo tempo quando o usuário não existe (não revela quem existe)
let dummyHash = null;

// ---------------------------------------------------------------- usuários (arquivo)
export function readUsers() {
  try {
    const d = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(d.users) ? d.users.filter((u) => u && validName(u.name) && typeof u.hash === 'string') : [];
  } catch {
    return [];
  }
}
export function writeUsers(users) {
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

export class Auth {
  constructor() {
    this.users = [];
    this.usersMtime = -1;
    this.sessions = new Map(); // hash -> { hash, user, createdAt, lastSeen, ua }
    this.fails = new Map(); // "ip:1.2.3.4" | "user:nome" -> [timestamps]
    this.saveTimer = null;
    this.reloadUsers();
    this.loadSessions();
    // ligado no servidor sempre; no local, só se alguém criou usuário (vale a partir do início)
    this.enabled = cfg.SERVER || this.users.length > 0;
  }

  // relê users.json quando ele muda (npm run user em outro terminal)
  reloadUsers() {
    let m = 0;
    try {
      m = fs.statSync(USERS_FILE).mtimeMs;
    } catch {
      m = 0;
    }
    if (m === this.usersMtime) return;
    this.usersMtime = m;
    this.users = readUsers();
  }

  user(name) {
    this.reloadUsers();
    return this.users.find((u) => u.name === name) || null;
  }

  // CLAWDDESK_ADMIN_USER + CLAWDDESK_ADMIN_PASSWORD: cria o usuário ou atualiza a senha dele
  async bootstrap() {
    const name = String(cfg.ADMIN_USER || '').trim().toLowerCase();
    if (!name || !cfg.ADMIN_PASSWORD) return null;
    if (!validName(name)) return `nome de usuário inválido em CLAWDDESK_ADMIN_USER ("${name}"): use letras minúsculas, números, ponto, hífen ou _`;
    if (cfg.ADMIN_PASSWORD.length < MIN_PASSWORD) return `a senha em CLAWDDESK_ADMIN_PASSWORD precisa de pelo menos ${MIN_PASSWORD} caracteres`;
    const users = readUsers();
    const u = users.find((x) => x.name === name);
    if (u && (await checkPassword(cfg.ADMIN_PASSWORD, u.hash))) return null;
    const now = Date.now();
    if (u) Object.assign(u, { hash: await hashPassword(cfg.ADMIN_PASSWORD), pwdAt: now });
    else users.push({ name, hash: await hashPassword(cfg.ADMIN_PASSWORD), createdAt: now, pwdAt: now });
    writeUsers(users);
    this.reloadUsers();
    this.enabled = true;
    return u ? `senha do usuário "${name}" atualizada (CLAWDDESK_ADMIN_PASSWORD)` : `usuário "${name}" criado (CLAWDDESK_ADMIN_USER)`;
  }

  // ---- sessões de login (cookie)
  loadSessions() {
    try {
      const d = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      for (const s of Array.isArray(d.sessions) ? d.sessions : []) if (s && s.hash && s.user && now - s.lastSeen < TTL) this.sessions.set(s.hash, s);
    } catch {
      /* sem logins salvos */
    }
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
        const tmp = `${SESSIONS_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()] }, null, 1), { mode: 0o600 });
        fs.renameSync(tmp, SESSIONS_FILE);
      } catch {
        /* sem disco: os logins valem até reiniciar */
      }
    }, 2000);
    this.saveTimer.unref();
  }

  // Lê o cookie e devolve { user, hash } se o login ainda vale
  check(cookieHeader) {
    if (!this.enabled) return null;
    const token = parseCookies(cookieHeader)[COOKIE];
    if (!token || token.length > 200) return null;
    const h = sha(token);
    const s = this.sessions.get(h);
    if (!s) return null;
    const now = Date.now();
    const u = this.user(s.user);
    if (!u || now - s.lastSeen > TTL || (u.pwdAt && s.createdAt < u.pwdAt)) {
      this.sessions.delete(h);
      this.saveSoon();
      return null;
    }
    if (now - s.lastSeen > 60e3) {
      s.lastSeen = now;
      this.saveSoon();
    }
    return { user: s.user, hash: h };
  }

  // Limite de tentativas: 10 erros em 15 min por endereço ou por usuário → espera.
  blocked(ip, name) {
    const now = Date.now();
    for (const k of [`ip:${ip}`, `user:${name}`]) {
      const recent = (this.fails.get(k) || []).filter((t) => now - t < 15 * 60e3);
      this.fails.set(k, recent);
      if (recent.length >= 10) return Math.ceil((recent[0] + 15 * 60e3 - now) / 60e3);
    }
    return 0;
  }

  failed(ip, name) {
    const now = Date.now();
    for (const k of [`ip:${ip}`, `user:${name}`]) this.fails.set(k, [...(this.fails.get(k) || []), now]);
    if (this.fails.size > 5000) this.fails.clear(); // não deixa a memória crescer sem fim
  }

  async login(name, password, ip, ua) {
    name = String(name || '').trim().toLowerCase().slice(0, 40);
    password = String(password || '').slice(0, 200);
    const wait = this.blocked(ip, name);
    if (wait) return { ok: false, status: 429, error: `muitas tentativas erradas — espere ${wait} min` };
    const u = this.user(name);
    if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(12).toString('hex'));
    const good = await checkPassword(password, u ? u.hash : dummyHash);
    if (!u || !good) {
      this.failed(ip, name);
      return { ok: false, status: 401, error: 'usuário ou senha incorretos' };
    }
    this.fails.delete(`user:${name}`);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const s = { hash: sha(token), user: u.name, createdAt: now, lastSeen: now, ua: String(ua || '').slice(0, 120) };
    this.sessions.set(s.hash, s);
    // no máximo 30 aparelhos logados por usuário: sai o mais antigo
    const mine = [...this.sessions.values()].filter((x) => x.user === u.name).sort((a, b) => a.lastSeen - b.lastSeen);
    for (const old of mine.slice(0, Math.max(0, mine.length - 30))) this.sessions.delete(old.hash);
    this.saveSoon();
    return { ok: true, token, user: u.name };
  }

  logout(hash) {
    if (this.sessions.delete(hash)) this.saveSoon();
  }

  cookie(token, secure) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL / 1000)}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie malformado: ignora */
    }
  }
  return out;
}
