#!/usr/bin/env node
// Dispara cenários de simulação no servidor local, sem gastar tokens.
//   npm run demo                → demonstração automática (todos os estados)
//   npm run demo -- permission  → idle | thinking | permission | done | warning80 | warning95 | normal | stop
const scenario = process.argv[2] || 'demo';
const port = Number(process.env.CLAWDDESK_PORT || 3456);

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  const j = await res.json();
  if (!j.ok) {
    console.error(`Cenário inválido: ${scenario}`);
    process.exit(1);
  }
  console.log(`▶ Simulação "${scenario}" enviada. ${scenario === 'stop' ? '' : 'Pare com: npm run demo -- stop'}`);
} catch {
  console.error(`Servidor não encontrado em http://127.0.0.1:${port} — rode "npm start" primeiro.`);
  process.exit(1);
}
