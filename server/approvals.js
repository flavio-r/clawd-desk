// Aprovar/negar pedidos de permissão do Claude Code pelo celular.
//
// Fluxo: o hook síncrono de PermissionRequest (hooks/clawddesk-permission.js) faz POST para
// /api/permission/request e fica esperando. O pedido aparece no celular com Permitir/Negar.
// A primeira resposta vence: se você responder no PC antes, o servidor libera o hook sem decisão.
//
// Segurança: só aparelhos pareados (código de 6 dígitos mostrado no terminal do PC) podem
// responder. O token do aparelho é guardado apenas como hash em data/paired.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as cfg from './config.js';

const PAIRED_FILE = path.join(cfg.DATA_DIR, 'paired.json');
const WAIT_MS = Math.max(10, Number(process.env.CLAWDDESK_APPROVAL_WAIT_S) || 110) * 1000;
const WAIT_DESKTOP_MS = Math.max(0, Number(process.env.CLAWDDESK_APPROVAL_WAIT_DESKTOP_S ?? 110)) * 1000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export class Approvals extends EventEmitter {
  constructor() {
    super();
    this.code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    this.devices = this.load(); // [{ hash, label, createdAt, lastSeen }]
    this.pending = new Map(); // id -> { id, sessionId, project, tool, createdAt, expiresAt, res, timer }
    this.attempts = new Map(); // ip -> [timestamps] (limite de tentativas de pareamento)
    this.onlineCheck = () => false; // trocado pelo index.js (há aparelho pareado conectado?)
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(PAIRED_FILE, 'utf8'));
      return Array.isArray(d.devices) ? d.devices : [];
    } catch {
      return [];
    }
  }

  save() {
    try {
      fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
      fs.writeFileSync(PAIRED_FILE, JSON.stringify({ devices: this.devices }, null, 2), { mode: 0o600 });
    } catch {
      /* sem persistência: o pareamento vale até reiniciar */
    }
  }

  get codeFormatted() {
    return `${this.code.slice(0, 3)} ${this.code.slice(3)}`;
  }

  // ---- pareamento
  pair(code, label, ip) {
    const now = Date.now();
    const recent = (this.attempts.get(ip) || []).filter((t) => now - t < 60e3);
    if (recent.length >= 5) return { ok: false, error: 'muitas tentativas — espere 1 minuto' };
    const clean = String(code || '').replace(/\D/g, '');
    if (clean !== this.code) {
      recent.push(now);
      this.attempts.set(ip, recent);
      return { ok: false, error: 'código incorreto' };
    }
    this.attempts.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    this.devices.push({ hash: sha(token), label: String(label || 'aparelho').slice(0, 40), createdAt: now, lastSeen: now });
    this.save();
    this.emit('change');
    return { ok: true, token };
  }

  verify(token) {
    if (!token) return null;
    const h = sha(token);
    const d = this.devices.find((x) => x.hash === h);
    if (d) d.lastSeen = Date.now();
    return d || null;
  }

  unpair(token) {
    const h = sha(token);
    const before = this.devices.length;
    this.devices = this.devices.filter((x) => x.hash !== h);
    if (this.devices.length !== before) {
      this.save();
      this.emit('change');
    }
    return before !== this.devices.length;
  }

  // ---- pedidos de permissão
  // Chamado pela rota do hook. Responde na hora (sem decisão) quando ninguém pode responder pelo celular.
  request(info, res) {
    const wait = info.entrypoint === 'claude-desktop' ? WAIT_DESKTOP_MS : WAIT_MS;
    if (!this.devices.length || !this.onlineCheck() || wait <= 0) {
      res.json({ decision: null, reason: !this.devices.length ? 'sem aparelho pareado' : 'celular desconectado' });
      return null;
    }
    const id = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const item = {
      id,
      sessionId: info.sessionId,
      project: info.project,
      tool: info.tool,
      mode: info.mode || null,
      entrypoint: info.entrypoint || null,
      createdAt: now,
      expiresAt: now + wait,
      res,
      timer: setTimeout(() => this.resolve(id, null, 'tempo esgotado'), wait),
    };
    this.pending.set(id, item);
    // se o hook for encerrado (ex.: respondido no PC e o Claude Code matou o processo), some da lista
    res.on('close', () => {
      if (this.pending.has(id)) this.resolve(id, null, 'hook encerrado');
    });
    this.emit('change');
    return item;
  }

  resolve(id, decision, reason) {
    const item = this.pending.get(id);
    if (!item) return null;
    this.pending.delete(id);
    clearTimeout(item.timer);
    try {
      if (!item.res.writableEnded) item.res.json({ decision, reason });
    } catch {
      /* conexão do hook já fechou */
    }
    this.emit('resolved', { ...item, decision, reason });
    this.emit('change');
    return item;
  }

  decide(id, decision, token) {
    if (!this.verify(token)) return { ok: false, status: 401, error: 'aparelho não pareado' };
    if (decision !== 'allow' && decision !== 'deny') return { ok: false, status: 400, error: 'decisão inválida' };
    const item = this.resolve(id, decision, 'celular');
    if (!item) return { ok: false, status: 410, error: 'esse pedido já foi respondido ou expirou' };
    return { ok: true, item };
  }

  // A sessão saiu do estado "aguardando" (respondida no PC, interrompida...): libera o hook.
  clearSession(sessionId) {
    for (const item of [...this.pending.values()]) if (item.sessionId === sessionId) this.resolve(item.id, null, 'respondido no PC');
  }

  view() {
    return {
      pairedDevices: this.devices.length,
      open: [...this.pending.values()].map(({ id, sessionId, project, tool, mode, createdAt, expiresAt }) => ({
        id,
        sessionId,
        project,
        tool,
        mode,
        createdAt,
        expiresAt,
      })),
    };
  }
}
