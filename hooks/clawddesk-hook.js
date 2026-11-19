#!/usr/bin/env node
// Hook do Claude Code → ClawdDesk.
// Lê o JSON do evento no stdin, enxuga (remove conteúdo de arquivos/saídas) e faz POST para
// http://127.0.0.1:3456/api/event. NUNCA escreve no stdout (no UserPromptSubmit isso viraria
// contexto para o Claude) e SEMPRE sai com código 0, mesmo com o servidor desligado.
import http from 'node:http';

const ts = Date.now();
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.CLAWDDESK_PORT || 3456);
const done = () => process.exit(0);
setTimeout(done, 4000); // trava de segurança

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
  // caixa "próximo passo" do app Claude (pergunta + botões)
  if (typeof input.ask === 'string') out.ask = cut(input.ask, 240);
  if (Array.isArray(input.actions)) out.options = input.actions.slice(0, 4).map((a) => cut(String((a && a.label) || ''), 60)).filter(Boolean);
  return out;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  if (raw.length < 20e6) raw += c;
});
process.stdin.on('error', done);
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return done();
  }
  const ev = {
    hook_event_name: data.hook_event_name,
    session_id: data.session_id,
    transcript_path: data.transcript_path,
    cwd: data.cwd,
    tool_name: data.tool_name,
    tool_input: slim(data.tool_input),
    prompt: cut(data.prompt, 500),
    message: cut(data.message, 300),
    title: cut(data.title, 120),
    notification_type: data.notification_type,
    source: data.source,
    reason: data.reason,
    // só o final da última resposta (para achar uma pergunta no fim)
    last_assistant_message: typeof data.last_assistant_message === 'string' ? data.last_assistant_message.slice(-700) : undefined,
    _ts: ts,
  };
  const body = JSON.stringify(ev);
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/api/event',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 1500,
    },
    (res) => {
      res.resume();
      res.on('end', done);
    }
  );
  req.on('error', done);
  req.on('timeout', () => {
    req.destroy();
    done();
  });
  req.end(body);
});
