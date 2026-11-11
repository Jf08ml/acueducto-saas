#!/bin/sh
# Lo corre la imagen de PostgreSQL SOLO al crear la base por primera vez (volumen vacío).
# Crea los roles de la aplicación con las contraseñas de deploy/.env.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_password="$AGUAMATA_OWNER_PASSWORD" \
  -v app_password="$AGUAMATA_APP_PASSWORD" \
  -f /opt/aguamata/production-roles.sql
