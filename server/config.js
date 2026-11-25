// Configuração central do ClawdDesk. Tudo pode ser ajustado por variáveis de ambiente.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (v, d = 0) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const ROOT = path.resolve(here, '..');
export const PUBLIC_DIR = process.env.CLAWDDESK_PUBLIC_DIR ? path.resolve(ROOT, process.env.CLAWDDESK_PUBLIC_DIR) : path.join(ROOT, 'public');
export const DATA_DIR = process.env.CLAWDDESK_DATA_DIR ? path.resolve(ROOT, process.env.CLAWDDESK_DATA_DIR) : path.join(ROOT, 'data');

// Nome deste computador nas telas de outros ClawdDesk (modo satélite). Ex.: CLAWDDESK_NAME="Notebook"
export const MACHINE_NAME = (process.env.CLAWDDESK_NAME || os.hostname().replace(/\.(local|lan|home)$/i, '')).slice(0, 32);

export const PORT = num(process.env.CLAWDDESK_PORT, 3456);
export const HOST = process.env.CLAWDDESK_HOST || '0.0.0.0';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');

// Leitura do uso real (5h / semanal) pela API OAuth do Claude.ai (mesma fonte do /usage).
// O token é lido do Keychain (macOS) ou de ~/.claude/.credentials.json e NUNCA sai do PC
// a não ser para api.anthropic.com. Desative com CLAWDDESK_OAUTH=0.
export const OAUTH_ENABLED = process.env.CLAWDDESK_OAUTH !== '0';
export const OAUTH_POLL_MS = Math.max(60, num(process.env.CLAWDDESK_OAUTH_POLL_S, 120)) * 1000;

// Fallback por estimativa (só quando não há dados oficiais): limites em USD equivalentes.
// Ex.: CLAWDDESK_EST_5H_USD=35 CLAWDDESK_EST_7D_USD=400
export const EST_5H_USD = num(process.env.CLAWDDESK_EST_5H_USD, 0);
export const EST_7D_USD = num(process.env.CLAWDDESK_EST_7D_USD, 0);

// Força o tamanho da janela de contexto (tokens) quando o statusLine não informa.
export const CONTEXT_WINDOW_OVERRIDE = num(process.env.CLAWDDESK_CONTEXT_WINDOW, 0);

// Sessões do Claude Code na web (claude.ai/code) e em outros PCs via Controle Remoto, pela mesma
// conta OAuth. Mostra as que tiveram atividade nas últimas N horas. Desative com CLAWDDESK_WEB=0.
export const WEB_ENABLED = process.env.CLAWDDESK_WEB !== '0' && OAUTH_ENABLED;
export const WEB_POLL_MS = Math.max(15, num(process.env.CLAWDDESK_WEB_POLL_S, 30)) * 1000;
export const WEB_RECENT_MS = Math.max(1, num(process.env.CLAWDDESK_WEB_RECENT_H, 12)) * 3600e3;

export const QUIET = process.env.CLAWDDESK_QUIET === '1';
