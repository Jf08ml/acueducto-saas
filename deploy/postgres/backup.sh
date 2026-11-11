#!/bin/sh
# Respaldo diario de la base: pg_dump en formato comprimido, uno al arrancar y luego cada 24 horas.
# Borra los de más de BACKUP_RETENTION_DAYS días. Restaurar: ver deploy/README.md.
set -u
mkdir -p /backups
while true; do
  file="/backups/aguamata-$(date -u +%Y%m%d-%H%M%S).dump"
  if pg_dump -Fc -f "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "$(date -u) respaldo listo: $file ($(du -h "$file" | cut -f1))"
  else
    rm -f "$file.tmp"
    echo "$(date -u) ERROR: falló el respaldo" >&2
  fi
  find /backups -name 'aguamata-*.dump' -mtime +"${BACKUP_RETENTION_DAYS:-14}" -delete
  sleep 86400
done
