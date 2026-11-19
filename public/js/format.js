// Formatação (pt-BR).
export function fmtDuration(ms, { seconds = false } = {}) {
  if (ms == null || !isFinite(ms)) return '—';
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return seconds ? `${m}m ${String(sec).padStart(2, '0')}s` : `${m} min`;
  return `${sec}s`;
}

export function fmtTokens(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 100) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtClock(d, withSeconds = false) {
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return withSeconds ? `${hm}:${String(d.getSeconds()).padStart(2, '0')}` : hm;
}

const DAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function fmtDate(d) {
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtWhen(ts) {
  const d = new Date(ts);
  return `${DAYS[d.getDay()]} ${fmtClock(d)}`;
}

export function fmtPct(p) {
  if (p == null || !isFinite(p)) return '—';
  return p < 10 && p > 0 ? p.toFixed(1).replace('.', ',') : String(Math.round(p));
}

// Tempo trabalhado: "48m", "2h57", "44h"
export function fmtWork(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 10 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${h}h`;
}

export function fmtDayMonth(ts) {
  const d = new Date(ts);
  return `${d.getDate()}/${MONTHS[d.getMonth()]}`;
}

// Reais: "R$ 18,57" (sem centavos a partir de R$ 100)
export function fmtBrl(usd, rate) {
  if (usd == null || !isFinite(usd) || !rate) return '';
  const v = usd * rate;
  const digits = v >= 100 ? 0 : 2;
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
  } catch {
    return 'R$ ' + v.toFixed(digits).replace('.', ',');
  }
}
