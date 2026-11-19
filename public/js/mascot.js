// Mascote pixel-art em SVG + partículas (código no "thinking", confete no "done").
import { PARTS } from './mascot-art.js';

const NS = 'http://www.w3.org/2000/svg';
const GLYPHS = ['{', '}', '<', '/>', ';', '=>', '()', '[]', '0', '1', '#', '&&', 'fn', '++', '::'];
const CONFETTI = ['#34d399', '#22d3ee', '#fbbf24', '#a855f7', '#f472b6', '#e07a52'];

export class Mascot {
  constructor(svg, particles) {
    this.svg = svg;
    this.particles = particles;
    this.mood = null;
    this.timer = null;
    this.live = 0;
    this.build();
  }

  build() {
    this.svg.setAttribute('viewBox', '0 0 32 32');
    this.svg.setAttribute('shape-rendering', 'crispEdges');
    for (const part of PARTS) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `p p-${part.name}`);
      for (const [x, y, w, h, color] of part.rects) {
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x);
        r.setAttribute('y', y);
        r.setAttribute('width', w);
        r.setAttribute('height', h);
        r.setAttribute('class', `c-${color}`);
        g.appendChild(r);
      }
      this.svg.appendChild(g);
    }
  }

  setMood(mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    clearInterval(this.timer);
    this.timer = null;
    if (mood === 'thinking') {
      this.timer = setInterval(() => this.codeParticle(), 260);
    } else if (mood === 'done') {
      this.confetti();
    }
  }

  spawn(cls, text, style) {
    if (this.live > 28 || document.hidden) return;
    const el = document.createElement('span');
    el.className = `particle ${cls}`;
    el.textContent = text;
    for (const k of Object.keys(style)) {
      if (k.startsWith('--')) el.style.setProperty(k, style[k]);
      else el.style[k] = style[k];
    }
    this.live++;
    const kill = () => {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
        this.live--;
      }
    };
    el.addEventListener('animationend', kill);
    setTimeout(kill, 4000);
    this.particles.appendChild(el);
  }

  codeParticle() {
    const g = GLYPHS[(Math.random() * GLYPHS.length) | 0];
    this.spawn(Math.random() < 0.5 ? 'code cyan' : 'code purple', g, {
      left: `${18 + Math.random() * 64}%`,
      top: `${52 + Math.random() * 18}%`,
      animationDuration: `${1.4 + Math.random() * 0.9}s`,
      fontSize: `${0.8 + Math.random() * 0.7}em`,
    });
  }

  confetti() {
    for (let i = 0; i < 26; i++) {
      const angle = Math.random() * Math.PI - Math.PI; // leque para cima
      const dist = 12 + Math.random() * 20; // em unidades --u
      this.spawn('confetti', '', {
        left: '50%',
        top: '38%',
        background: CONFETTI[i % CONFETTI.length],
        '--dx': (Math.cos(angle) * dist).toFixed(1),
        '--dy': (Math.sin(angle) * dist).toFixed(1),
        animationDelay: `${Math.random() * 0.15}s`,
      });
    }
  }
}
