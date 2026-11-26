#!/usr/bin/env node
// npm run user — usuários e senhas para entrar no ClawdDesk.
//
//   npm run user -- list               lista os usuários
//   npm run user -- add NOME           cria (pergunta a senha duas vezes, sem mostrar)
//   npm run user -- passwd NOME        troca a senha (desconecta os aparelhos logados com a antiga)
//   npm run user -- remove NOME        remove (desconecta os aparelhos dele na hora)
//
// No modo servidor o login é obrigatório. No modo local ele liga quando existe pelo menos um
// usuário (e desliga se todos forem removidos), valendo a partir do próximo início.
// Para scripts: CLAWDDESK_PASSWORD="..." npm run user -- add NOME (não pergunta nada).
import * as cfg from '../server/config.js';
import { readUsers, writeUsers, hashPassword, validName, MIN_PASSWORD, USERS_FILE } from '../server/auth.js';

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` };
const [cmd, rawName] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const name = String(rawName || '').trim().toLowerCase();
const fail = (msg) => {
  console.error(c.r(`\n  ✖ ${msg}\n`));
  process.exit(1);
};

// lê uma linha sem mostrar o que é digitado (senha)
function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(`  ${question} `);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const k of ch) {
        if (k === '\r' || k === '\n' || k === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (k === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (k === '\u007f' || k === '\b') buf = buf.slice(0, -1);
        else if (k >= ' ') buf += k;
      }
    };
    stdin.on('data', onData);
  });
}

async function newPassword() {
  if (process.env.CLAWDDESK_PASSWORD) {
    const p = process.env.CLAWDDESK_PASSWORD;
    if (p.length < MIN_PASSWORD) fail(`A senha precisa de pelo menos ${MIN_PASSWORD} caracteres.`);
    return p;
  }
  // senha vinda de um pipe (echo "senha" | npm run user -- add NOME): primeira linha, sem repetir
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const ch of process.stdin) chunks.push(ch);
    const p = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
    if (p.length < MIN_PASSWORD) fail(`A senha precisa de pelo menos ${MIN_PASSWORD} caracteres.`);
    return p;
  }
  for (let i = 0; i < 3; i++) {
    const p1 = await askHidden(`Senha (mínimo ${MIN_PASSWORD} caracteres):`);
    if (p1.length < MIN_PASSWORD) {
      console.log(c.y(`  A senha precisa de pelo menos ${MIN_PASSWORD} caracteres. Tente de novo.`));
      continue;
    }
    const p2 = await askHidden('Repita a senha:');
    if (p1 === p2) return p1;
    console.log(c.y('  As duas senhas não são iguais. Tente de novo.'));
  }
  fail('Senha não definida.');
}

// o ClawdDesk deste computador está rodando? e com o login ligado?
async function runningLogin() {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.PORT}/api/me`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? !!(await r.json()).login : null;
  } catch {
    return null;
  }
}

async function afterChange(users) {
  const running = await runningLogin();
  if (cfg.SERVER || running === true) {
    if (users.length) console.log(c.d('  Já vale: o ClawdDesk relê os usuários sozinho.\n'));
    else console.log(c.y('  Sem usuários, o modo servidor não inicia da próxima vez. Crie outro com: npm run user -- add NOME\n'));
    return;
  }
  if (users.length && running === false) console.log(`  ${c.y('→')} Reinicie o ClawdDesk para ligar o login: ${c.b('npm run restart')}\n`);
  else if (users.length) console.log(c.d(`  O login liga no próximo início (npm start). A tela vai pedir usuário e senha.\n`));
  else console.log(c.d('  Sem usuários, o login desliga no próximo início (no modo local).\n'));
}

async function main() {
  const users = readUsers();
  if (!cmd || cmd === 'help') {
    console.log(`\n  ${c.b('👤 Usuários do ClawdDesk')} ${c.d(`(${USERS_FILE})`)}`);
    console.log(`    npm run user -- list            lista`);
    console.log(`    npm run user -- add NOME        cria`);
    console.log(`    npm run user -- passwd NOME     troca a senha`);
    console.log(`    npm run user -- remove NOME     remove\n`);
    return;
  }
  if (cmd === 'list') {
    if (!users.length) return console.log(c.d(`\n  Nenhum usuário. ${cfg.SERVER ? 'O modo servidor precisa de um' : 'O login está desligado neste PC'}: npm run user -- add NOME\n`));
    console.log('');
    for (const u of users) {
      const since = new Date(u.createdAt || 0).toLocaleDateString('pt-BR');
      const pwd = u.pwdAt && u.pwdAt !== u.createdAt ? ` · senha trocada em ${new Date(u.pwdAt).toLocaleDateString('pt-BR')}` : '';
      console.log(`  👤 ${c.b(u.name)} ${c.d(`criado em ${since}${pwd}`)}`);
    }
    console.log('');
    return;
  }
  if (!['add', 'passwd', 'remove'].includes(cmd)) fail(`Comando desconhecido: ${cmd}. Use list, add, passwd ou remove.`);
  if (!validName(name)) fail('Nome inválido. Use de 2 a 32 letras minúsculas, números, ponto, hífen ou _ (ex.: flavio, ana.souza).');
  const u = users.find((x) => x.name === name);
  const now = Date.now();

  if (cmd === 'add') {
    if (u) fail(`O usuário "${name}" já existe. Para trocar a senha: npm run user -- passwd ${name}`);
    console.log(`\n  ${c.b(`👤 Novo usuário: ${name}`)}`);
    const pass = await newPassword();
    users.push({ name, hash: await hashPassword(pass), createdAt: now, pwdAt: now });
    writeUsers(users);
    console.log(`  ${c.g('✔')} Usuário ${c.b(name)} criado.`);
    return afterChange(users);
  }
  if (!u) fail(`Não existe usuário "${name}". Veja os que existem: npm run user -- list`);
  if (cmd === 'passwd') {
    console.log(`\n  ${c.b(`👤 Nova senha para ${name}`)}`);
    const pass = await newPassword();
    Object.assign(u, { hash: await hashPassword(pass), pwdAt: now });
    writeUsers(users);
    console.log(`  ${c.g('✔')} Senha trocada. Os aparelhos que estavam logados como ${name} precisam entrar de novo.`);
    return afterChange(users);
  }
  // remove
  const rest = users.filter((x) => x !== u);
  writeUsers(rest);
  console.log(`\n  ${c.g('✔')} Usuário ${c.b(name)} removido. Os aparelhos dele saem na hora.`);
  return afterChange(rest);
}

main().catch((e) => fail(e.message));
