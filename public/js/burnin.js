// Proteção anti burn-in para OLED: desloca a interface inteira 2–4 px a cada 5 minutos.
export function startBurnInShift(el, intervalMs = 5 * 60e3) {
  const step = () => {
    const mag = () => (2 + Math.round(Math.random() * 2)) * (Math.random() < 0.5 ? -1 : 1);
    el.style.transform = `translate(${mag()}px, ${mag()}px)`;
  };
  return setInterval(step, intervalMs);
}
