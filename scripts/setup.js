#!/usr/bin/env node
// npm run setup — assistente de primeira configuração do ClawdDesk.
//
// Verifica o computador, instala as dependências, conecta ao Claude Code (pedindo permissão),
// inicia o monitor e explica como conectar o celular. Pode ser rodado de novo sem problema.
//
//   npm run setup            modo guiado (pergunta antes de mexer nas configurações do Claude Code)
//   npm run setup -- --yes   responde "sim" para tudo (útil para automatizar)
//
// Usa só módulos nativos do Node até as dependências estarem instaladas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const YES = process.argv.includes('--yes') || process.argv.includes('-y');
const PORT = Number(process.env.CLAWDDESK_PORT || 3456);
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const WIN = process.platform === 'win32';

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  cy: (s) => `\x1b[36m${s}\x1b[0m`,
};
const ok = (s) => console.log(`  ${c.g('✔')} ${s}`);
const warn = (s) => console.log(`  ${c.y('⚠')} ${s}`);
const fail = (s) => console.log(`  ${c.r('✖')} ${s}`);
const step = (n, total, s) => console.log(`\n${c.cy(`[${n}/${total}]`)} ${c.b(s)}`);

async function ask(question, def = true) {
  if (YES || !process.stdin.isTTY) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const hint = def ? 'S/n' : 's/N';
  const answer = await new Promise((r) => rl.question(`  ${question} ${c.d(`(${hint})`)} `, r));
  rl.close();
  const a = answer.trim().toLowerCase();
  if (!a) return def;
  return a.startsWith('s') || a.startsWith('y');
}

function claudeVersion() {
  try {
    const v = execFileSync(WIN ? 'claude.cmd' : 'claude', ['--version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    return v.replace(/\(Claude Code\)/i, '').trim();
  } catch {
    return null;
  }
}

function hooksStatus() {
  try {
    const txt = fs.readFileSync(SETTINGS, 'utf8');
    const hasHook = txt.includes('clawddesk-hook.js');
    const hasPerm = txt.includes('clawddesk-permission.js');
    const here = txt.includes(path.join(ROOT, 'hooks').replace(/\\/g, '\\\\')) || txt.includes(path.join(ROOT, 'hooks'));
    if (hasHook && hasPerm && here) return 'ok';
    if (hasHook) return 'desatualizado';
    return 'ausente';
  } catch {
    return 'ausente';
  }
}

async function portBusy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? 'clawddesk' : 'outro';
  } catch (e) {
    return e && e.cause && e.cause.code === 'ECONNREFUSED' ? 'livre' : 'livre';
  }
}

async function main() {
  console.log('');
  console.log(`  ${c.b('🤖 Bem-vindo ao ClawdDesk!')}`);
  console.log(`  ${c.d('Vou preparar tudo em 4 passos. Leva cerca de 1 minuto.')}`);

  // 1) computador
  step(1, 4, 'Verificando o computador');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    fail(`Node.js ${process.versions.node} é antigo. Instale a versão LTS em https://nodejs.org e rode de novo.`);
    process.exit(1);
  }
  ok(`Node.js ${process.versions.node}`);

  const cv = claudeVersion();
  if (cv) ok(`Claude Code encontrado ${c.d(`(${cv})`)}`);
  else if (fs.existsSync(CLAUDE_DIR)) ok(`Claude Code encontrado ${c.d(`(pasta ${CLAUDE_DIR})`)}`);
  else {
    warn('Não encontrei o Claude Code neste computador.');
    console.log(c.d('     Instale em https://docs.claude.com/en/docs/claude-code e use-o pelo menos uma vez.'));
    if (!(await ask('Continuar mesmo assim?', false))) process.exit(1);
  }

  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) {
    console.log(`  ${c.d('Instalando as dependências (npm install)…')}`);
    const r = spawnSync(WIN ? 'npm.cmd' : 'npm', ['install', '--no-fund', '--no-audit'], { cwd: ROOT, stdio: 'inherit', shell: WIN });
    if (r.status !== 0) {
      fail('Não consegui instalar as dependências. Verifique a internet e rode "npm install".');
      process.exit(1);
    }
  }
  ok('Dependências instaladas');

  // 2) Claude Code
  step(2, 4, 'Conectando ao Claude Code');
  const hs = hooksStatus();
  if (hs === 'ok') ok('Já está conectado (hooks instalados)');
  else {
    console.log(`  Para saber o que o Claude Code está fazendo, o ClawdDesk adiciona ${c.b('hooks')} às`);
    console.log(`  configurações dele (${c.d(SETTINGS)}).`);
    console.log(`  ${c.d('Antes, faço um backup do arquivo. Para desfazer depois: npm run remove-hooks')}`);
    const go = await ask(hs === 'desatualizado' ? 'Atualizar a conexão com o Claude Code?' : 'Posso conectar ao Claude Code?', true);
    if (go) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-hooks.js'), '--from-setup'], { cwd: ROOT, stdio: 'inherit', env: process.env });
      if (r.status !== 0) {
        fail('Não consegui conectar ao Claude Code (veja a mensagem acima).');
        process.exit(1);
      }
    } else {
      warn('Sem conexão, o monitor abre mas não vai mostrar as sessões. Rode "npm run setup" quando quiser.');
    }
  }

  // 3) servidor
  step(3, 4, 'Iniciando o monitor');
  const busy = await portBusy(PORT);
  if (busy === 'clawddesk') {
    warn(`Já existe um ClawdDesk rodando na porta ${PORT}.`);
    if (!(await ask('Reiniciar com esta versão?', true))) {
      console.log(c.d(`\n  Tudo pronto. O monitor continua rodando em http://localhost:${PORT}\n`));
      process.exit(0);
    }
  }

  // 4) celular (o guia aparece junto com o endereço e o QR Code, logo abaixo)
  step(4, 4, 'Conectando o celular');
  console.log(c.d('  O endereço, o QR Code e o passo a passo aparecem logo abaixo.'));
  console.log(c.d('  Deixe esta janela aberta: fechar ela desliga o monitor.\n'));
  process.env.CLAWDDESK_GUIDE = '1';
  if (busy === 'clawddesk') await import(pathToFileURL(path.join(ROOT, 'scripts', 'restart.js')).href);
  else await import(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href);
}

main().catch((e) => {
  fail(e && e.message ? e.message : String(e));
  process.exit(1);
});
