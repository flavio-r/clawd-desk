// Tela sempre ligada com dupla proteção:
//  1) Screen Wake Lock API (só existe em contexto seguro: HTTPS ou localhost);
//  2) fallback para HTTP na rede local: um <video> em tela cheia, atrás de tudo, tocando em loop
//     um stream gerado por Canvas (preto puro) + trilha silenciosa do Web Audio — o Chrome
//     segura a tela acesa enquanto há vídeo visível tocando (técnica "NoSleep").
export class KeepAwake {
  constructor(sfx, onChange) {
    this.sfx = sfx;
    this.onChange = onChange || (() => {});
    this.sentinel = null;
    this.video = null;
    this.enabled = false;
    document.addEventListener('visibilitychange', () => this.revive());
    window.addEventListener('focus', () => this.revive());
  }

  get supportsWakeLock() {
    return 'wakeLock' in navigator && window.isSecureContext;
  }

  // Chamar dentro de um gesto do usuário (toque).
  async enable() {
    this.enabled = true;
    this.startVideo(); // inicia já, dentro do gesto, antes de qualquer await
    await this.requestWakeLock();
    this.onChange(this.status());
  }

  async requestWakeLock() {
    if (!this.supportsWakeLock || this.sentinel || document.visibilityState !== 'visible') return !!this.sentinel;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
        this.onChange(this.status());
      });
      return true;
    } catch {
      this.sentinel = null;
      return false;
    }
  }

  startVideo() {
    if (this.video) {
      this.video.play().catch(() => {});
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 64, 36);
    if (!canvas.captureStream) return;
    const stream = canvas.captureStream(4);
    try {
      const ac = this.sfx.ensure();
      if (ac && ac.createMediaStreamDestination) {
        const dest = ac.createMediaStreamDestination();
        const osc = ac.createOscillator();
        const g = ac.createGain();
        g.gain.value = 0; // silêncio absoluto
        osc.connect(g);
        g.connect(dest);
        osc.start();
        dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
      }
    } catch {
      /* só vídeo já basta */
    }
    const v = document.createElement('video');
    v.id = 'nosleep';
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.setAttribute('aria-hidden', 'true');
    v.muted = true;
    v.autoplay = true;
    v.loop = true;
    v.srcObject = stream;
    document.body.insertBefore(v, document.body.firstChild);
    this.video = v;
    // redesenha 1 pixel a cada segundo para o stream nunca "congelar"
    let flip = false;
    setInterval(() => {
      flip = !flip;
      ctx.fillStyle = flip ? '#000000' : '#010101';
      ctx.fillRect(0, 0, 1, 1);
    }, 1000);
    v.addEventListener('playing', () => this.onChange(this.status()));
    v.addEventListener('pause', () => this.onChange(this.status()));
    v.play().catch(() => {});
  }

  revive() {
    if (!this.enabled || document.visibilityState !== 'visible') return;
    this.requestWakeLock().then(() => this.onChange(this.status()));
    if (this.video && this.video.paused) this.video.play().catch(() => {});
  }

  status() {
    return {
      enabled: this.enabled,
      wakeLock: !!this.sentinel,
      video: !!(this.video && !this.video.paused),
    };
  }
}
