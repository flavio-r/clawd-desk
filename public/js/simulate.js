// Painel "Simular estados": dispara cenários no servidor (aparecem em todas as telas
// conectadas) e testa os sons localmente — sem gastar nenhum token.
const SCENARIOS = [
  ['idle', '😴 Idle'],
  ['thinking', '⚙️ Trabalhando'],
  ['permission', '✋ Permissão'],
  ['done', '✅ Concluído'],
  ['question', '❓ Pergunta'],
  ['warning80', '⚠️ Uso 80%'],
  ['warning95', '🚨 Uso 95%'],
  ['normal', '📉 Uso normal'],
  ['demo', '▶️ Demo automático'],
];
const SOUNDS = [
  ['permission', '🔔 Permissão'],
  ['done', '🎵 Concluído'],
  ['warn80', '📢 Alerta 80%'],
  ['warn95', '🚨 Alerta 95%'],
];

export class SimPanel {
  constructor(root, sfx, opts = {}) {
    this.root = root;
    this.sfx = sfx;
    this.onPair = opts.onPair || (() => {});
    this.render();
    // atalhos no PC: teclas 1–9 disparam os cenários, 0 sai da simulação
    window.addEventListener('keydown', (e) => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= SCENARIOS.length) this.send(SCENARIOS[n - 1][0]);
      if (e.key === '0') this.send('stop');
      if (e.key === 'Escape') this.close();
    });
  }

  render() {
    const btn = (label, cls, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    const card = document.createElement('div');
    card.className = 'sim-card';
    card.addEventListener('click', (e) => e.stopPropagation());
    const head = document.createElement('div');
    head.className = 'sim-head';
    head.innerHTML = '<b>🧪 Simular estados</b><span>sem gastar tokens · aparece em todas as telas</span>';
    head.appendChild(btn('✕', 'sim-close', () => this.close()));
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'sim-grid';
    SCENARIOS.forEach(([id, label], i) => {
      const b = btn(label, 'sim-btn', () => this.send(id));
      b.title = `Tecla ${i + 1}`;
      grid.appendChild(b);
    });
    card.appendChild(grid);

    const cap = document.createElement('div');
    cap.className = 'sim-caption';
    cap.textContent = 'Testar sons e vibração neste aparelho:';
    card.appendChild(cap);
    const sounds = document.createElement('div');
    sounds.className = 'sim-grid sim-sounds';
    for (const [id, label] of SOUNDS) sounds.appendChild(btn(label, 'sim-btn ghost', () => this.testSound(id)));
    card.appendChild(sounds);

    const pairRow = document.createElement('div');
    pairRow.className = 'sim-pair';
    this.pairLabel = document.createElement('span');
    this.pairLabel.textContent = '🔐 Aprovar pelo celular: este aparelho não está pareado';
    pairRow.appendChild(this.pairLabel);
    pairRow.appendChild(btn('Parear / gerenciar', 'sim-btn ghost', () => {
      this.close();
      this.onPair();
    }));
    card.appendChild(pairRow);

    card.appendChild(btn('⏹ Sair da simulação (voltar ao real)', 'sim-btn stop', () => this.send('stop')));
    this.status = document.createElement('div');
    this.status.className = 'sim-status';
    card.appendChild(this.status);
    this.root.appendChild(card);
    this.root.addEventListener('click', () => this.close());
  }

  testSound(id) {
    this.sfx.unlock();
    this.sfx.play(id);
    if (id === 'permission' && navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if (this.sfx.muted) this.status.textContent = 'Som está mudo — toque no 🔇 para ativar.';
  }

  async send(scenario) {
    try {
      const r = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      this.status.textContent = r.ok ? (scenario === 'stop' ? 'Simulação encerrada.' : `Cenário: ${scenario}`) : 'Erro ao simular.';
    } catch {
      this.status.textContent = 'Sem conexão com o PC.';
    }
  }

  setPairStatus(paired) {
    if (this.pairLabel) {
      this.pairLabel.textContent = paired
        ? '🔐 Aprovar pelo celular: este aparelho está pareado ✓'
        : '🔐 Aprovar pelo celular: este aparelho não está pareado';
    }
  }

  open() {
    this.root.hidden = false;
  }

  close() {
    this.root.hidden = true;
  }

  toggle() {
    this.root.hidden ? this.open() : this.close();
  }
}
