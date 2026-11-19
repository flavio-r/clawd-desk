#!/usr/bin/env node
// Hook de PermissionRequest do ClawdDesk: deixa você aprovar/negar o pedido pelo celular.
//
// Envia o pedido ao servidor e espera a resposta do celular (até ~110 s). Enquanto isso o
// pedido continua aparecendo no PC: vale a primeira resposta. Se o servidor estiver desligado,
// se nenhum celular estiver pareado/conectado, ou se o tempo acabar, não responde nada e o
// Claude Code segue normalmente (pergunta só no PC). Sempre sai com código 0.
import http from 'node:http';

const ts = Date.now();
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.CLAWDDESK_PORT || 3456);
const quit = () => process.exit(0);
setTimeout(quit, 130e3); // trava de segurança (o Claude Code encerra o hook em 120 s)

const KEEP = ['file_path', 'notebook_path', 'path', 'command', 'description', 'pattern', 'url', 'query', 'subagent_type', 'skill', 'prompt'];
const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);
function slim(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const k of KEEP) if (typeof input[k] === 'string') out[k] = cut(input[k], k === 'prompt' ? 200 : 300);
  const q = Array.isArray(input.questions) && input.questions[0];
  if (q) {
    out.question = cut(String(q.question || ''), 200);
    if (Array.isArray(q.options)) out.options = q.options.slice(0, 6).map((o) => cut(String((o && (o.label || o)) || ''), 60));
  }
  return out;
}

function answer(decision) {
  const out =
    decision === 'allow'
      ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
      : { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Negado pelo celular (ClawdDesk).' } } };
  process.stdout.write(JSON.stringify(out));
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  if (raw.length < 20e6) raw += c;
});
process.stdin.on('error', quit);
process.stdin.on('end', () => {
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return quit();
  }
  const body = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    session_id: d.session_id,
    transcript_path: d.transcript_path,
    cwd: d.cwd,
    tool_name: d.tool_name,
    tool_input: slim(d.tool_input),
    permission_mode: d.permission_mode,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,
    _ts: ts,
  });
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/api/permission/request',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 125e3,
    },
    (res) => {
      let txt = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (txt += c));
      res.on('end', () => {
        try {
          const r = JSON.parse(txt);
          if (r.decision === 'allow' || r.decision === 'deny') answer(r.decision);
        } catch {
          /* sem decisão: o Claude Code pergunta no PC */
        }
        quit();
      });
    }
  );
  req.on('error', quit);
  req.on('timeout', () => {
    req.destroy();
    quit();
  });
  req.end(body);
});
