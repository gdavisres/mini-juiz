#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f "$SCRIPT_DIR/src/worker.mjs" ]; then
    echo "Coloque este script na pasta do Mini Juiz, junto da pasta src."
    read -p "Pressione [Enter] para sair..."
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js nao encontrado no PATH."
    read -p "Pressione [Enter] para sair..."
    exit 1
fi

# Abre o Worker 1 em uma nova janela de terminal
gnome-terminal --title="Mini Juiz - worker-1" -- bash -c "export WORKER_ID=worker-1; node src/worker.mjs; exec bash"

# Abre o Worker 2 em outra nova janela de terminal
gnome-terminal --title="Mini Juiz - worker-2" -- bash -c "export WORKER_ID=worker-2; node src/worker.mjs; exec bash"