#!/usr/bin/env node
// Instala (ou remove) os hooks e o statusLine do ClawdDesk no settings.json do Claude Code.
//
//   npm run setup-hooks                 instala/atualiza (idempotente)
//   npm run remove-hooks                remove tudo e restaura seu statusLine original
//
// Opções: --settings <arquivo>  --port <n>  --minimal (só os 5 eventos básicos, sem async)
//         --no-statusline  --dry-run
//
// Segurança: faz backup com data/hora antes de gravar, aborta se o JSON atual for inválido,
// grava de forma atômica (arquivo temporário + rename) e só mexe nas entradas do ClawdDesk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks', 'clawddesk-hook.js');
const STATUS = path.join(ROOT, 'hooks', 'clawddesk-statusline.js');
const PERMISSION = path.join(ROOT, 'hooks', 'clawddesk-permission.js');
const CHAIN = path.join(ROOT, 'data', 'statusline-chain.json');
const MARK_HOOK = 'clawddesk-hook.js';
const MARK_PERMISSION = 'clawddesk-permission.js';
const MARK_STATUS = 'clawddesk-statusline.js';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i > -1 ? args[i + 1] : undefined;
};
const uninstall = flag('--uninstall');
const minimal = flag('--minimal');
const dryRun = flag('--dry-run');
const withStatusline = !flag('--no-statusline');
const port = Number(opt('--port') || process.env.CLAWDDESK_PORT || 3456);
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = path.resolve(opt('--settings') || path.join(claudeDir, 'settings.json'));

const CORE = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
// Eventos extras (Claude Code 2.x): PermissionRequest dispara NA HORA em que o pedido de
// permissão aparece (a Notification "permission_prompt" só vem ~6 s depois).
const EXTRA = ['PermissionRequest', 'PostToolUseFailure', 'StopFailure', 'SessionStart', 'SessionEnd', 'PreCompact'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m` };

// Caminho estável do Node: prefere o "node" do PATH (ex.: /opt/homebrew/bin/node, que continua
// válido após um "brew upgrade") em vez do caminho versionado de process.execPath (…/Cellar/node/X/…).
function nodeBin() {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const cand = path.join(dir, exe);
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      return cand;
    } catch {
      /* próximo */
    }
  }
  return process.execPath;
}

function commandFor(script) {
  const portArg = port !== 3456 ? ['--port', String(port)] : [];
  const node = nodeBin();
  if (process.platform === 'win32') {
    // forma "exec" (sem shell): evita problemas de aspas no PowerShell/Git Bash
    return { command: node, args: [script, ...portArg] };
  }
  const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
  return { command: [q(node), q(script), ...portArg].join(' ') };
}

function isOurs(h) {
  if (!h || typeof h !== 'object') return false;
  const s = `${h.command || ''} ${(h.args || []).join(' ')}`;
  return s.includes(MARK_HOOK) || s.includes(MARK_PERMISSION);
}

function stripOurHooks(hooks) {
  if (!hooks || typeof hooks !== 'object') return {};
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const rest = g.hooks.filter((h) => !isOurs(h));
      if (rest.length) kept.push({ ...g, hooks: rest });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

function readSettings() {
  if (!fs.existsSync(settingsPath)) return { exists: false, data: {} };
  const text = fs.readFileSync(settingsPath, 'utf8');
  if (!text.trim()) return { exists: true, data: {} };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('raiz não é um objeto');
    return { exists: true, data };
  } catch (e) {
    console.error(c.r(`\n  ✖ ${settingsPath} não é um JSON válido (${e.message}).`));
    console.error('    Nada foi alterado. Corrija o arquivo e rode novamente.\n');
    process.exit(1);
  }
}

function backup(exists) {
  if (!exists) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let dest = `${settingsPath}.clawddesk-backup-${stamp}`;
  for (let n = 2; fs.existsSync(dest); n++) dest = `${settingsPath}.clawddesk-backup-${stamp}-${n}`;
  fs.copyFileSync(settingsPath, dest, fs.constants.COPYFILE_EXCL);
  return dest;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.clawddesk-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function install() {
  const { exists, data } = readSettings();
  const next = { ...data };
  const hooks = stripOurHooks(data.hooks);
  const events = minimal ? CORE : [...CORE, ...EXTRA];
  const cmd = commandFor(HOOK);
  for (const ev of events) {
    let hook;
    if (ev === 'PermissionRequest') {
      // síncrono: espera a resposta do celular (Permitir/Negar). O pedido segue aparecendo no PC.
      hook = { type: 'command', ...commandFor(PERMISSION), timeout: 120 };
    } else {
      hook = { type: 'command', ...cmd, timeout: 5 };
      if (!minimal && ev !== 'SessionEnd') hook.async = true; // não bloqueia o Claude
    }
    const group = TOOL_EVENTS.has(ev) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] };
    hooks[ev] = [...(hooks[ev] || []), group];
  }
  next.hooks = hooks;

  let statusNote = c.d('statusLine não alterado (--no-statusline)');
  if (withStatusline) {
    const current = data.statusLine;
    const scmd = commandFor(STATUS);
    const ours = current && `${current.command || ''} ${(current.args || []).join(' ')}`.includes(MARK_STATUS);
    if (current && !ours) {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(CHAIN), { recursive: true });
        fs.writeFileSync(CHAIN, JSON.stringify(current, null, 2) + '\n');
      }
      statusNote = `statusLine original preservado e encadeado ${c.d(`(${path.relative(ROOT, CHAIN)})`)}`;
    } else statusNote = ours ? 'statusLine do ClawdDesk atualizado' : 'statusLine do ClawdDesk instalado';
    const keep = current || {};
    const { args: _a, ...rest } = keep;
    next.statusLine = { ...rest, type: 'command', ...scmd, padding: keep.padding ?? 0 };
  }

  if (dryRun) {
    console.log(JSON.stringify({ hooks: next.hooks, statusLine: next.statusLine }, null, 2));
    return;
  }
  const bak = backup(exists);
  writeAtomic(settingsPath, next);

  console.log(`\n  ${c.g('✔')} ${c.b('Hooks do ClawdDesk instalados')} em ${settingsPath}`);
  if (bak) console.log(`  ${c.g('✔')} Backup: ${c.d(bak)}`);
  console.log(`  ${c.g('✔')} Eventos: ${events.join(', ')}${minimal ? '' : c.d(' (assíncronos, não deixam o Claude mais lento)')}`);
  if (!minimal) console.log(`  ${c.g('✔')} PermissionRequest: espera sua resposta pelo celular pareado ${c.d('(o pedido continua aparecendo no PC)')}`);
  console.log(`  ${c.g('✔')} ${statusNote}`);
  if (flag('--from-setup')) return; // o assistente (npm run setup) continua daqui
  console.log(`\n  ${c.y('→')} Reinicie as sessões abertas do Claude Code para carregar os hooks.`);
  console.log(`  ${c.y('→')} Depois: ${c.b('npm start')} e abra o endereço mostrado no celular.`);
  console.log(c.d(`  Para desfazer: npm run remove-hooks\n`));
}

function remove() {
  const { exists, data } = readSettings();
  if (!exists) {
    console.log(c.d(`\n  Nada a remover: ${settingsPath} não existe.\n`));
    return;
  }
  const next = { ...data };
  const hooks = stripOurHooks(data.hooks);
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;

  let statusNote = 'statusLine mantido';
  const current = data.statusLine;
  const ours = current && `${current.command || ''} ${(current.args || []).join(' ')}`.includes(MARK_STATUS);
  const hadHooks = JSON.stringify(hooks) !== JSON.stringify(data.hooks || {});
  if (!hadHooks && !ours) {
    console.log(`\n  ${c.g('✔')} Nada a remover: o ClawdDesk não está instalado em ${settingsPath}`);
    console.log(c.d('  Nenhum arquivo foi alterado.\n'));
    return;
  }
  if (ours) {
    let original = null;
    try {
      original = JSON.parse(fs.readFileSync(CHAIN, 'utf8'));
    } catch {
      original = null;
    }
    if (original) {
      next.statusLine = original;
      statusNote = 'statusLine original restaurado';
    } else {
      delete next.statusLine;
      statusNote = 'statusLine do ClawdDesk removido';
    }
  }
  if (dryRun) {
    console.log(JSON.stringify({ hooks: next.hooks, statusLine: next.statusLine }, null, 2));
    return;
  }
  const bak = backup(true);
  writeAtomic(settingsPath, next);
  if (ours) fs.rmSync(CHAIN, { force: true });
  console.log(`\n  ${c.g('✔')} ${c.b('ClawdDesk removido')} de ${settingsPath}`);
  console.log(`  ${c.g('✔')} Backup: ${c.d(bak)}`);
  console.log(`  ${c.g('✔')} ${statusNote}`);
  console.log(c.d('  Reinicie as sessões abertas do Claude Code.\n'));
}

if (!fs.existsSync(HOOK) || !fs.existsSync(STATUS) || !fs.existsSync(PERMISSION)) {
  console.error(c.r('  ✖ Scripts de hook não encontrados em ./hooks — rode a partir da pasta do projeto.'));
  process.exit(1);
}
uninstall ? remove() : install();
