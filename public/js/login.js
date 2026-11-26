// Tela de login (só aparece quando o ClawdDesk tem usuários: servidor online ou login ligado no PC).
const $ = (id) => document.getElementById(id);
const form = $('login-form');
const msg = $('msg');

// sem cadeado e fora da rede de casa: avisa que a senha vai aberta
const h = location.hostname;
const lan = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)|\.local$|^\[?::1\]?$/.test(h);
if (location.protocol === 'http:' && !lan) $('insecure').hidden = false;

$('show').addEventListener('click', () => {
  const p = $('password');
  const show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $('show').setAttribute('aria-pressed', String(show));
  $('show').setAttribute('aria-label', show ? 'Esconder a senha' : 'Mostrar a senha');
  p.focus();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = $('user').value.trim();
  const password = $('password').value;
  if (!user || !password) {
    msg.textContent = 'Preencha o usuário e a senha.';
    (user ? $('password') : $('user')).focus();
    return;
  }
  $('go').disabled = true;
  msg.dataset.ok = 'wait';
  msg.textContent = 'Entrando…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      msg.dataset.ok = '1';
      msg.textContent = '✓ Pronto!';
      location.replace('/');
      return;
    }
    // o login foi desligado (ex.: usuários removidos no PC): volta para a tela
    if (r.status === 404) return location.replace('/');
    msg.dataset.ok = '0';
    msg.textContent = `✕ ${j.error || 'não deu certo'}`;
    $('password').select();
  } catch {
    msg.dataset.ok = '0';
    msg.textContent = '✕ Sem conexão com o ClawdDesk.';
  }
  $('go').disabled = false;
});
