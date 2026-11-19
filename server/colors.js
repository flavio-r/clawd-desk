// Cor fixa por projeto: cada projeto novo recebe a cor menos usada da paleta (8 cores) e
// guarda essa escolha em data/colors.json. Assim os projetos não se repetem e não mudam de cor.
import fs from 'node:fs';
import path from 'node:path';
import * as cfg from './config.js';

const FILE = path.join(cfg.DATA_DIR, 'colors.json');
export const PALETTE_SIZE = 8;

export class ColorRegistry {
  constructor() {
    try {
      this.map = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    } catch {
      this.map = {};
    }
  }

  get(name) {
    if (!name) return 0;
    if (Number.isInteger(this.map[name])) return this.map[name];
    const counts = new Array(PALETTE_SIZE).fill(0);
    for (const i of Object.values(this.map)) if (Number.isInteger(i) && i < PALETTE_SIZE) counts[i]++;
    const idx = counts.indexOf(Math.min(...counts));
    this.map[name] = idx;
    try {
      fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.map, null, 2));
    } catch {
      /* sem persistência: vale até reiniciar */
    }
    return idx;
  }
}
