// Arte pixel do mascote (grade 32x32). Cada parte vira um <g class="p-NOME"> no SVG e é
// mostrada/animada pelo CSS conforme o humor (data-mood). Também usada pelo gerador de ícones.
// Retângulos: [x, y, largura, altura, cor]

export const PALETTE = {
  body: '#e07a52',
  shade: '#a9502f',
  hi: '#f6a47f',
  metal: '#a3aebd',
  metalDark: '#5d6878',
  frame: '#1d3140',
  screen: '#061017',
  eye: '#5ef1ff',
  led: '#ff9e6b',
  kbd: '#161d27',
  key: '#2b3a4b',
  keyGlow: '#22d3ee',
  amber: '#fbbf24',
  green: '#34d399',
  sweat: '#7dd3fc',
  zz: '#8b95a5',
};

const keys = [];
for (let x = 7; x <= 24; x += 2) keys.push([x, 27, 1, 1, 'keyGlow']);

export const PARTS = [
  { name: 'antenna', icon: true, rects: [[15, 3, 2, 3, 'metal'], [14, 0, 4, 3, 'led'], [14, 0, 1, 1, 'hi']] },
  { name: 'ears', icon: true, rects: [[5, 9, 2, 5, 'metalDark'], [25, 9, 2, 5, 'metalDark'], [4, 10, 1, 3, 'metal'], [27, 10, 1, 3, 'metal']] },
  {
    name: 'head',
    icon: true,
    rects: [
      [8, 6, 16, 12, 'body'],
      [7, 7, 1, 10, 'body'],
      [24, 7, 1, 10, 'body'],
      [8, 6, 16, 1, 'hi'],
      [7, 7, 1, 1, 'hi'],
      [8, 17, 16, 1, 'shade'],
      [24, 16, 1, 1, 'shade'],
    ],
  },
  { name: 'screen', icon: true, rects: [[9, 8, 14, 9, 'frame'], [10, 9, 12, 7, 'screen']] },
  { name: 'eyes', icon: true, rects: [[12, 10, 2, 3, 'eye'], [18, 10, 2, 3, 'eye']] },
  { name: 'mouth-idle', icon: true, rects: [[14, 14, 4, 1, 'eye']] },
  { name: 'mouth-smile', rects: [[13, 13, 1, 1, 'eye'], [14, 14, 4, 1, 'eye'], [18, 13, 1, 1, 'eye']] },
  { name: 'mouth-o', rects: [[15, 13, 2, 2, 'eye']] },
  { name: 'mouth-worry', rects: [[13, 14, 1, 1, 'eye'], [14, 13, 4, 1, 'eye'], [18, 14, 1, 1, 'eye']] },
  { name: 'mouth-busy', rects: [[14, 14, 1, 1, 'eye'], [16, 14, 1, 1, 'eye'], [18, 14, 1, 1, 'eye']] },
  { name: 'neck', icon: true, rects: [[14, 18, 4, 1, 'metalDark']] },
  {
    name: 'torso',
    icon: true,
    rects: [
      [10, 19, 12, 7, 'body'],
      [10, 19, 12, 1, 'hi'],
      [10, 25, 12, 1, 'shade'],
      [13, 21, 6, 3, 'frame'],
      [14, 22, 1, 1, 'led'],
      [16, 22, 2, 1, 'eye'],
    ],
  },
  { name: 'legs', icon: true, rects: [[12, 26, 3, 3, 'metalDark'], [17, 26, 3, 3, 'metalDark'], [11, 29, 4, 2, 'shade'], [17, 29, 4, 2, 'shade']] },
  { name: 'arm-l', icon: true, rects: [[7, 19, 3, 2, 'metalDark'], [7, 21, 2, 4, 'body'], [7, 25, 2, 1, 'metal']] },
  { name: 'arm-r', icon: true, rects: [[22, 19, 3, 2, 'metalDark'], [23, 21, 2, 4, 'body'], [23, 25, 2, 1, 'metal']] },
  {
    name: 'arms-up',
    rects: [
      [7, 19, 3, 2, 'metalDark'],
      [5, 19, 2, 1, 'body'],
      [4, 15, 2, 4, 'body'],
      [4, 14, 2, 1, 'metal'],
      [22, 19, 3, 2, 'metalDark'],
      [25, 19, 2, 1, 'body'],
      [26, 15, 2, 4, 'body'],
      [26, 14, 2, 1, 'metal'],
    ],
  },
  { name: 'keyboard', rects: [[5, 26, 22, 3, 'kbd'], [5, 26, 22, 1, 'key'], ...keys] },
  { name: 'exclaim', rects: [[28, 0, 2, 5, 'amber'], [28, 6, 2, 2, 'amber']] },
  { name: 'check', rects: [[24, 3, 2, 2, 'green'], [26, 5, 2, 2, 'green'], [28, 3, 2, 2, 'green'], [30, 1, 2, 2, 'green']] },
  { name: 'sweat', rects: [[27, 4, 1, 1, 'sweat'], [26, 5, 3, 2, 'sweat'], [27, 7, 1, 1, 'sweat']] },
  { name: 'zz', rects: [[25, 1, 3, 1, 'zz'], [26, 2, 1, 1, 'zz'], [25, 3, 3, 1, 'zz'], [29, 0, 2, 1, 'zz'], [29, 1, 1, 1, 'zz'], [29, 2, 2, 1, 'zz']] },
];
