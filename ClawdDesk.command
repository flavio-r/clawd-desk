#!/bin/bash
# ClawdDesk — dois cliques para abrir (macOS).
# Na primeira vez configura tudo; nas próximas só inicia o monitor.
cd "$(dirname "$0")" || exit 1

# O Finder abre com um PATH mínimo: procura o Node nos lugares mais comuns.
if ! command -v node >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
    [ -x "$p/node" ] && export PATH="$p:$PATH"
  done
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  O Node.js não está instalado neste Mac."
  echo "  1. Abra https://nodejs.org e baixe a versão LTS."
  echo "  2. Instale (é só avançar) e abra este arquivo de novo."
  echo ""
  read -n 1 -s -r -p "  Pressione qualquer tecla para fechar..."
  exit 1
fi

npm run setup
echo ""
read -n 1 -s -r -p "  O ClawdDesk foi encerrado. Pressione qualquer tecla para fechar..."
