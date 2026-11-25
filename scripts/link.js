#!/usr/bin/env node
// npm run link — liga ESTE computador a um ClawdDesk principal (o que está com o celular).
//
//   npm run link -- 192.168.0.10 123456     endereço do principal + código de pareamento dele
//   npm run link                            pergunta os dois
//   npm run unlink                          desfaz (este PC para de enviar)
//
// O endereço e o código aparecem no terminal do ClawdDesk principal ("No celular: http://…" e
// "Código para parear…"). Depois de ligar, reinicie o ClawdDesk deste PC (npm run restart).
import fs from 'node:fs';
import readline from 'node:readline';
import * as cfg from '../server/config.js';
import { HUB_FILE, readHubConfig } from '../server/satellite.js';
import { lanAddresses } from '../server/net.js';

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` };
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const remove = process.argv.includes('--remove');

async function ask(q) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(`  ${q} `, r));
  rl.close();
  return a.trim();
}

function normalize(addr) {
  let a = String(addr || '').trim();
  if (!a) return null;
  if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
  try {
    const u = new URL(a);
    if (!u.port) u.port = '3456';
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function unlink() {
  const conf = readHubConfig();
  if (!conf) {
    console.log(c.d('\n  Este PC não está ligado a nenhum ClawdDesk principal. Nada a fazer.\n'));
    return;
  }
  try {
    await fetch(`${conf.url}/api/unpair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: conf.token }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    /* principal fora do ar: só apaga o vínculo daqui */
  }
  fs.rmSync(HUB_FILE, { force: true });
  console.log(`\n  ${c.g('✔')} Este PC parou de enviar as sessões para ${conf.url}.`);
  console.log(c.d('    Reinicie o ClawdDesk deste PC (npm run restart) para valer.\n'));
}

async function link() {
  console.log(`\n  ${c.b('🛰  Ligar este PC a um ClawdDesk principal')}`);
  console.log(c.d('  As sessões do Claude Code deste PC vão aparecer na tela (e no celular) do outro.'));
  console.log(c.d('  No terminal do principal estão o endereço ("No celular: http://…") e o código.\n'));

  let url = normalize(args[0] || (await ask('Endereço do ClawdDesk principal (ex.: 192.168.0.10):')));
  if (!url) {
    console.error(c.r('  ✖ Endereço inválido. Ex.: npm run link -- 192.168.0.10 123456\n'));
    process.exit(1);
  }
  const u = new URL(url);
  const me = new Set(['localhost', '127.0.0.1', '::1', ...lanAddresses().map((a) => a.address)]);
  if (me.has(u.hostname) && Number(u.port) === cfg.PORT) {
    console.error(c.r('  ✖ Esse endereço é deste mesmo computador. Use o endereço do OUTRO PC (o que está com o celular).\n'));
    process.exit(1);
  }

  // é mesmo um ClawdDesk?
  try {
    const r = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (!r.ok || !j || !j.port) throw new Error('resposta estranha');
  } catch {
    console.error(c.r(`  ✖ Não achei um ClawdDesk em ${url}.`));
    console.error('    Confira se ele está aberto no outro PC, se o endereço está certo e se os dois estão no mesmo Wi-Fi.\n');
    process.exit(1);
  }

  const code = String(args[1] || (await ask('Código de pareamento (6 dígitos, aparece no terminal do principal):'))).replace(/\D/g, '');
  if (code.length !== 6) {
    console.error(c.r('  ✖ O código tem 6 dígitos. Ex.: npm run link -- 192.168.0.10 123456\n'));
    process.exit(1);
  }
  let j;
  try {
    const r = await fetch(`${url}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: `PC: ${cfg.MACHINE_NAME}` }),
      signal: AbortSignal.timeout(6000),
    });
    j = await r.json();
  } catch (e) {
    console.error(c.r(`  ✖ Falha ao falar com ${url}: ${e.message}\n`));
    process.exit(1);
  }
  if (!j || !j.ok || !j.token) {
    console.error(c.r(`  ✖ Pareamento recusado: ${(j && j.error) || 'erro desconhecido'}.`));
    console.error('    O código muda toda vez que o ClawdDesk principal reinicia — confira o atual no terminal dele.\n');
    process.exit(1);
  }
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  fs.writeFileSync(HUB_FILE, JSON.stringify({ url, token: j.token, linkedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });

  console.log(`  ${c.g('✔')} Pronto! Este PC (${c.b(cfg.MACHINE_NAME)}) está ligado ao ClawdDesk em ${url}.`);
  // o ClawdDesk deste PC já está rodando? precisa reiniciar para começar a enviar
  let running = false;
  try {
    running = (await fetch(`http://127.0.0.1:${cfg.PORT}/api/info`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    running = false;
  }
  console.log(
    running
      ? `  ${c.y('→')} Agora reinicie o ClawdDesk deste PC: ${c.b('npm run restart')}`
      : `  ${c.y('→')} Agora abra o ClawdDesk deste PC: ${c.b('npm start')} ${c.d('(ou dois cliques no arquivo ClawdDesk)')}`
  );
  console.log(c.d(`  Para desfazer: npm run unlink · Para mudar o nome mostrado: CLAWDDESK_NAME="Notebook" npm start\n`));
}

(remove ? unlink() : link()).catch((e) => {
  console.error(c.r(`  ✖ ${e.message}`));
  process.exit(1);
});
