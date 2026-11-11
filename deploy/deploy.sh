#!/usr/bin/env bash
# Despliega o actualiza AguaMata en el VPS: construye las imágenes, aplica migraciones y levanta los servicios.
#   ./deploy.sh            # con el código actual de la carpeta
#   ./deploy.sh --pull     # trae primero los últimos cambios de git (rama actual)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Falta deploy/.env. Copia .env.example a .env y complétalo." >&2
  exit 1
fi
if [ "${1:-}" = "--pull" ]; then
  git -C .. pull --ff-only
fi

compose() { docker compose -f docker-compose.prod.yml "$@"; }

echo "→ Construyendo imágenes…"
compose --profile tools build migrate web

echo "→ Base de datos y Redis…"
compose up -d postgres redis

echo "→ Migraciones…"
compose --profile tools run --rm migrate

echo "→ Levantando API, web, Caddy y respaldos…"
compose up -d api web caddy backup

echo "→ Estado:"
compose ps
echo
echo "Listo. Revisa el log de la API con: docker compose -f docker-compose.prod.yml logs -f api"
