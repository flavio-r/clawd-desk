// Tema da tela: escuro (padrão, ideal para OLED), claro (bom para telas LCD e ambientes claros)
// ou automático (segue o modo claro/escuro do celular). A escolha fica salva só neste aparelho.
// Na URL, ?tema=claro|escuro|auto força um tema sem salvar (útil no modo quiosque).
const KEY = 'cd.theme';
const ORDER = ['dark', 'light', 'auto'];
const ALIAS = { escuro: 'dark', claro: 'light', auto: 'auto', automatico: 'auto', dark: 'dark', light: 'light' };
export const THEME_LABEL = { dark: 'escuro', light: 'claro', auto: 'automático' };
export const THEME_ICON = { dark: '🌙', light: '☀️', auto: '🌓' };
// fundo de cada tema (também pinta o vídeo que mantém a tela ligada, que fica atrás de tudo)
const BG = { dark: '#000000', light: '#e8edf2' };

function read() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function write(v) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* sem armazenamento: vale só até recarregar */
  }
}

export class Theme {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    const fromUrl = ALIAS[new URLSearchParams(location.search).get('tema')] || null;
    this.forced = !!fromUrl;
    this.pref = fromUrl || ALIAS[read()] || 'dark';
    this.mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    if (this.mq) {
      const onSys = () => this.pref === 'auto' && this.apply();
      if (this.mq.addEventListener) this.mq.addEventListener('change', onSys);
      else if (this.mq.addListener) this.mq.addListener(onSys);
    }
    this.apply(false); // na criação só pinta a tela; quem criou lê o tema depois
  }

  // tema efetivo agora (auto vira claro ou escuro conforme o celular)
  get resolved() {
    if (this.pref === 'auto') return this.mq && this.mq.matches ? 'light' : 'dark';
    return this.pref;
  }

  get background() {
    return BG[this.resolved];
  }

  apply(notify = true) {
    const t = this.resolved;
    const root = document.documentElement;
    root.dataset.theme = t;
    root.style.colorScheme = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BG[t]);
    if (notify) this.onChange(t, this.pref);
  }

  // escuro → claro → automático → escuro…
  cycle() {
    this.pref = ORDER[(ORDER.indexOf(this.pref) + 1) % ORDER.length];
    this.forced = false;
    write(this.pref);
    this.apply();
    return this.pref;
  }
}
