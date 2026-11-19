#!/usr/bin/env node
// npm run restart — encerra o ClawdDesk que estiver rodando na porta e sobe a versão atual.
// Só encerra processos que sejam o próprio ClawdDesk (node server/index.js); se a porta estiver
// ocupada por outro programa, avisa e não mexe em nada.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.CLAWDDESK_PORT || 3456);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listeners() {
  if (process.platform === 'win32') return [];
  try {
    return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function commandOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cwdOf(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : '';
  } catch {
    return '';
  }
}

// É o ClawdDesk? (iniciado por "npm start" → server/index.js, ou por "npm run restart" → scripts/restart.js)
function isClawdDesk(pid) {
  const cmd = commandOf(pid);
  if (!/(server[\\/]index|scripts[\\/]restart)\.js/.test(cmd)) return false;
  const cwd = cwdOf(pid);
  return !cwd || path.resolve(cwd) === ROOT || cmd.includes(ROOT);
}

const pids = listeners().filter((pid) => pid !== process.pid);
for (const pid of pids) {
  const cmd = commandOf(pid);
  if (!isClawdDesk(pid)) {
    console.error(`\n  ✖ A porta ${port} está ocupada por outro programa (PID ${pid}: ${cmd || '?'}).`);
    console.error('    Não vou encerrá-lo. Feche esse programa ou use: CLAWDDESK_PORT=3457 npm start\n');
    process.exit(1);
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`  ⏹  ClawdDesk antigo encerrado (PID ${pid}).`);
  } catch (e) {
    console.error(`  ✖ Não consegui encerrar o PID ${pid}: ${e.message}`);
    process.exit(1);
  }
}
for (let i = 0; i < 24 && pids.length && listeners().length; i++) await sleep(250);
if (pids.length && listeners().length) {
  console.error(`  ✖ A porta ${port} continua ocupada. Tente de novo em alguns segundos.`);
  process.exit(1);
}

await import('../server/index.js');
