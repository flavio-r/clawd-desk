// Efeitos sonoros 100% sintetizados com Web Audio API (nenhum arquivo de áudio).
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* modo anônimo etc. */
    }
  },
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = store.get('cd.muted', '0') === '1';
    this.volume = Math.min(1, Math.max(0, parseFloat(store.get('cd.volume', '0.7')) || 0.7));
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.applyVolume();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // Precisa ser chamado dentro de um toque (política de autoplay do Chrome).
  unlock() {
    const c = this.ensure();
    if (!c) return;
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.start(0);
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  applyVolume() {
    if (!this.master) return;
    const v = this.muted ? 0 : this.volume * this.volume; // curva mais natural
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setMuted(m) {
    this.muted = !!m;
    store.set('cd.muted', this.muted ? '1' : '0');
    this.applyVolume();
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    store.set('cd.volume', String(this.volume));
    this.applyVolume();
  }

  // Uma nota com envelope (ataque/decay exponencial) e filtro opcional.
  note(freq, t0, dur, { type = 'sine', gain = 0.3, attack = 0.008, glideTo = null, filter = null } = {}) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let out = g;
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      g.connect(f);
      out = f;
    }
    o.connect(g);
    out.connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  play(name) {
    if (this.muted) return;
    const c = this.ensure();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime + 0.03;
    switch (name) {
      case 'permission': {
        // bipe duplo, suave porém urgente
        for (const [i, f] of [[0, 988], [1, 1319]]) {
          const s = t + i * 0.2;
          this.note(f, s, 0.16, { type: 'triangle', gain: 0.42 });
          this.note(f / 2, s, 0.16, { type: 'sine', gain: 0.18 });
        }
        break;
      }
      case 'done': {
        // acorde curto agradável (arpejo Dó maior com timbre de sino)
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          const s = t + i * 0.075;
          this.note(f, s, 1.3, { type: 'sine', gain: 0.22 });
          this.note(f * 2.01, s, 0.5, { type: 'sine', gain: 0.05 });
        });
        break;
      }
      case 'warn80': {
        this.note(784, t, 0.2, { type: 'square', gain: 0.16, filter: 1800 });
        this.note(587, t + 0.24, 0.32, { type: 'square', gain: 0.16, filter: 1800 });
        break;
      }
      case 'warn95': {
        for (let r = 0; r < 2; r++) {
          const s = t + r * 0.62;
          this.note(880, s, 0.12, { type: 'square', gain: 0.2, filter: 2400 });
          this.note(880, s + 0.16, 0.12, { type: 'square', gain: 0.2, filter: 2400 });
          this.note(659, s + 0.32, 0.22, { type: 'square', gain: 0.2, filter: 2400 });
        }
        break;
      }
      case 'tick':
        this.note(1400, t, 0.05, { type: 'sine', gain: 0.25 });
        break;
      default:
        break;
    }
  }
}
