#!/usr/bin/env node
// statusLine do Claude Code → ClawdDesk.
// Repassa o JSON (modelo, contexto, custo e rate_limits 5h/7d) para /api/statusline e imprime
// uma linha de status. Se você já tinha um statusLine, o setup-hooks guardou o comando original
// em data/statusline-chain.json e ele continua sendo executado aqui (a saída dele é a exibida).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.CLAWDDESK_PORT || 3456);
setTimeout(() => process.exit(0), 6000);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', main);
process.stdin.on('error', () => process.exit(0));

function post() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/statusline',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
        timeout: 600,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end(raw);
  });
}

function runChain(command) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out));
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    kill.unref();
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
  });
}

function ownLine(d, online) {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const parts = [];
  parts.push(online ? '\x1b[38;5;209m●\x1b[0m ClawdDesk' : dim('○ ClawdDesk offline'));
  if (d.model && d.model.display_name) parts.push(d.model.display_name);
  const cw = d.context_window;
  if (cw && cw.used_percentage != null) parts.push(`ctx ${Math.round(cw.used_percentage)}%`);
  const rl = d.rate_limits || {};
  if (rl.five_hour && rl.five_hour.used_percentage != null) parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl.seven_day && rl.seven_day.used_percentage != null) parts.push(`7d ${Math.round(rl.seven_day.used_percentage)}%`);
  if (d.cost && typeof d.cost.total_cost_usd === 'number') {
    let rate = Number(process.env.CLAWDDESK_USD_BRL) || 0;
    if (!rate) {
      try {
        rate = Number(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'fx.json'), 'utf8')).usdBrl) || 0;
      } catch {
        rate = 0;
      }
    }
    const usd = d.cost.total_cost_usd;
    const brl = rate ? ' · R$ ' + (usd * rate).toFixed(2).replace('.', ',') : '';
    parts.push('$' + usd.toFixed(2) + brl);
  }
  return parts.join(dim(' · '));
}

async function main() {
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    /* segue com objeto vazio */
  }
  let chain = null;
  try {
    chain = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'statusline-chain.json'), 'utf8'));
  } catch {
    chain = null;
  }
  const posting = post();
  if (chain && chain.command) {
    const out = await runChain(chain.command);
    if (out != null) process.stdout.write(out);
    await posting;
  } else {
    const online = await posting;
    process.stdout.write(ownLine(data, online) + '\n');
  }
  process.exit(0);
}
