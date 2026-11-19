// Cor de cada projeto: sempre a mesma para o mesmo nome (hash do nome → paleta).
// Usada no robô do núcleo, nos mini-robôs dos cartões e na linha do tempo.
export const PROJECT_COLORS = [
  { body: '#e07a52', shade: '#a9502f', hi: '#f6a47f' }, // coral
  { body: '#2dd4bf', shade: '#0f8f80', hi: '#8af2e3' }, // turquesa
  { body: '#a78bfa', shade: '#6d4fd1', hi: '#d0c2ff' }, // violeta
  { body: '#a3e635', shade: '#5f8f12', hi: '#d4f69c' }, // lima
  { body: '#f472b6', shade: '#b83c80', hi: '#f9b9da' }, // rosa
  { body: '#38bdf8', shade: '#0d7fb5', hi: '#9adffd' }, // céu
  { body: '#fb923c', shade: '#b85a12', hi: '#fdc797' }, // laranja
  { body: '#818cf8', shade: '#4f55c9', hi: '#c0c5fc' }, // índigo
];

export function projectColor(name = '') {
  let h = 2166136261;
  for (const ch of String(name)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return PROJECT_COLORS[h % PROJECT_COLORS.length];
}

const NS = 'http://www.w3.org/2000/svg';

// Cabeça do robô em pixel-art (16x14), na cor do projeto.
export function miniRobot(color) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 14');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'mini-bot');
  const rects = [
    [7, 0, 2, 2, color.hi],
    [1, 5, 1, 4, color.shade],
    [14, 5, 1, 4, color.shade],
    [2, 2, 12, 11, color.body],
    [2, 2, 12, 1, color.hi],
    [2, 12, 12, 1, color.shade],
    [4, 4, 8, 6, '#061017'],
    [5, 6, 2, 2, '#5ef1ff'],
    [9, 6, 2, 2, '#5ef1ff'],
  ];
  for (const [x, y, w, h, fill] of rects) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x);
    r.setAttribute('y', y);
    r.setAttribute('width', w);
    r.setAttribute('height', h);
    r.setAttribute('fill', fill);
    svg.appendChild(r);
  }
  return svg;
}
