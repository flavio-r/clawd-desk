// Cotação do dólar (USD → BRL) para mostrar os custos também em reais.
// Fonte principal: AwesomeAPI (cotação do dia, atualizada ao longo do dia). Reserva: open.er-api.com.
// Só pede "USD-BRL" — nenhum dado seu é enviado. Atualiza a cada 6 h e guarda a última em data/fx.json.
// Para usar uma cotação fixa: CLAWDDESK_USD_BRL=5.50 npm start
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as cfg from './config.js';

const FILE = path.join(cfg.DATA_DIR, 'fx.json');
const EVERY_MS = 6 * 3600e3;
const RETRY_MS = 30 * 60e3;

export class FxRate extends EventEmitter {
  constructor() {
    super();
    const fixed = Number(process.env.CLAWDDESK_USD_BRL);
    this.fixed = fixed > 0 ? fixed : null;
    this.state = this.fixed ? { usdBrl: this.fixed, source: 'fixa (CLAWDDESK_USD_BRL)', at: Date.now() } : this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return d && d.usdBrl > 0 ? d : null;
    } catch {
      return null;
    }
  }

  start() {
    if (this.fixed) return;
    const due = this.state ? Math.max(0, this.state.at + EVERY_MS - Date.now()) : 0;
    setTimeout(() => this.refresh(), due).unref();
  }

  async refresh() {
    let next = EVERY_MS;
    try {
      const r = await this.fetchAwesome().catch(() => this.fetchErApi());
      this.state = { ...r, at: Date.now() };
      try {
        fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(this.state, null, 2));
      } catch {
        /* sem persistência */
      }
      this.emit('change');
    } catch {
      next = RETRY_MS; // sem internet: tenta de novo em 30 min (usa a última cotação conhecida)
    }
    setTimeout(() => this.refresh(), next).unref();
  }

  async fetchAwesome() {
    const res = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    const v = Number(j && j.USDBRL && j.USDBRL.bid);
    if (!(v > 0)) throw new Error('cotação inválida');
    return { usdBrl: v, source: 'AwesomeAPI' };
  }

  async fetchErApi() {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    const v = Number(j && j.rates && j.rates.BRL);
    if (!(v > 0)) throw new Error('cotação inválida');
    return { usdBrl: v, source: 'open.er-api.com' };
  }

  view() {
    return this.state ? { usdBrl: this.state.usdBrl, source: this.state.source, at: this.state.at } : null;
  }
}
