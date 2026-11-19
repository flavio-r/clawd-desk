// Preços públicos da API (USD por 1M de tokens) usados só para ESTIMAR o custo a partir dos
// logs locais. Assinantes Pro/Max não pagam por token; o valor serve como "custo equivalente".
// cacheRead: quando omitido vale 10% do input. Escrita em cache: 1,25x (5 min) / 2x (1 h).
const TABLE = [
  [/fable-5-2|mythos-5-2/, 8, 40, 0.2],
  [/fable-5|mythos-5/, 10, 50],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-5/, 5, 25],
  [/opus-4-[5-9]/, 5, 25],
  [/opus-4|opus-3|3-opus/, 15, 75],
  [/sonnet-5-5/, 2, 10, 0.1],
  [/sonnet-5/, 2, 10],
  [/sonnet-4|sonnet-3|3-[57]-sonnet/, 3, 15],
  [/haiku-5-5/, 0.1, 0.5],
  [/haiku-4-5/, 1, 5],
  [/haiku-3-5|3-5-haiku/, 0.8, 4],
  [/haiku/, 0.25, 1.25],
];

function priceFor(model = '') {
  const m = String(model).toLowerCase();
  for (const [re, input, output, cacheRead] of TABLE) {
    if (re.test(m)) return { input, output, cacheRead: cacheRead ?? input * 0.1 };
  }
  return null;
}

export function costFor(model, u = {}) {
  if (!model || model === '<synthetic>') return 0;
  const p = priceFor(model);
  if (!p) return 0;
  const cc = u.cache_creation || {};
  const w1h = Number(cc.ephemeral_1h_input_tokens) || 0;
  const w5mRaw = Number(cc.ephemeral_5m_input_tokens);
  const writeTotal = Number(u.cache_creation_input_tokens) || 0;
  const w5m = Number.isFinite(w5mRaw) ? w5mRaw : Math.max(0, writeTotal - w1h);
  const usd =
    (Number(u.input_tokens) || 0) * p.input +
    (Number(u.output_tokens) || 0) * p.output +
    w5m * p.input * 1.25 +
    w1h * p.input * 2 +
    (Number(u.cache_read_input_tokens) || 0) * p.cacheRead;
  return usd / 1e6;
}

const MILLION = /\[1m\]|fable|mythos|opus-5|sonnet-5|haiku-5|opus-4-[6-9]|sonnet-4-6/i;

export function contextWindowFor(model = '') {
  return MILLION.test(String(model)) ? 1_000_000 : 200_000;
}

export function prettyModel(id = '') {
  if (!id) return null;
  const m = String(id).toLowerCase().match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}
