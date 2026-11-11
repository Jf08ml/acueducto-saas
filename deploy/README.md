# Despliegue en un VPS

Todo corre con Docker Compose en un solo servidor:

| Servicio | Qué hace |
|---|---|
| `postgres` | Base de datos. |
| `redis` | Cola de tareas. |
| `api` | La API, con el worker de la cola. |
| `web` | La web. |
| `caddy` | HTTPS automático. |
| `backup` | Respaldo diario de la base. |

Variables y detalles: [../docs/despliegue.md](../docs/despliegue.md).

## 1. Servidor

- Ubuntu 22.04 o 24.04, mínimo **2 vCPU y 4 GB de RAM** (compilar la web pide memoria), 40 GB de disco.
- Firewall: abre solo **22** (SSH), **80** y **443**. La base y Redis no se publican.
- Instala Docker y el plugin de Compose:
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER   # cierra y vuelve a abrir la sesión
  ```

## 2. DNS

En tu proveedor de dominio, apunta al IP del VPS (registros `A`):

| Nombre | Para qué |
|---|---|
| `aguamata.co` | La plataforma. |
| `www.aguamata.co` | Redirige a la plataforma. |
| `*.aguamata.co` | El subdominio de cada acueducto. |
| `tenants.aguamata.co` | Destino del CNAME de los dominios propios de los acueductos (cubierto por el comodín). |

Espera a que resuelvan (`dig +short aguamata.co`) antes del paso 4: Let's Encrypt valida contra el DNS.

## 3. Código y configuración

```bash
git clone https://github.com/Jf08ml/acueducto-saas.git aguamata
cd aguamata/deploy
cp .env.example .env
nano .env
```

Genera los secretos así:
```bash
openssl rand -hex 24      # POSTGRES_PASSWORD, AGUAMATA_OWNER_PASSWORD, AGUAMATA_APP_PASSWORD (una distinta cada una)
openssl rand -base64 32   # APP_ENCRYPTION_KEY
```

- **Guarda `APP_ENCRYPTION_KEY` y las contraseñas en un gestor de secretos.** Sin la clave no se pueden descifrar las claves técnicas de la DIAN.
- El correo es obligatorio: SES o SMTP, con un remitente verificado (SPF, DKIM y DMARC del dominio).

## 4. Primer despliegue

```bash
chmod +x deploy.sh
./deploy.sh
docker compose -f docker-compose.prod.yml --profile tools run --rm seed   # plan, catálogo y superadmin (solo la primera vez)
```

Verifica:
- `docker compose -f docker-compose.prod.yml ps`: todo `Up`; api y web `(healthy)`.
- `docker compose -f docker-compose.prod.yml logs api | grep Config`: si falta algo crítico, la API no arranca y lo dice aquí.
- Abre `https://aguamata.co`, entra con el superadmin y en **Cobros** define el precio del plan, la cuenta bancaria y los plazos.
- Mercado Pago (opcional): registra el webhook `https://aguamata.co/api/v1/public/payments/mercadopago/webhook` (evento *Pagos*), pon `MP_ACCESS_TOKEN` y `MP_WEBHOOK_SECRET` en `.env` y corre `./deploy.sh`.

## 5. Actualizar

```bash
cd aguamata/deploy
./deploy.sh --pull
```

Trae los cambios, reconstruye las imágenes, aplica las migraciones y reinicia lo necesario. Hay unos segundos sin servicio mientras se reinician la API y la web.

## 6. Respaldos

- El servicio `backup` guarda un respaldo de la base cada 24 horas en `deploy/backups/` y borra los de más de `BACKUP_RETENTION_DAYS` días.
- **Cópialos fuera del servidor:** un respaldo en el mismo disco no sirve si se pierde el VPS. Por ejemplo, con [rclone](https://rclone.org) hacia S3, R2 o Google Drive en un cron diario:
  ```bash
  0 4 * * * rclone copy /ruta/aguamata/deploy/backups remoto:aguamata-backups
  ```
- Con `STORAGE_DRIVER=local`, los archivos (logos, comprobantes, PDF) están en el volumen `aguamata_storage`. Inclúyelo en tu respaldo o usa S3.
- **Restaurar** un respaldo (detén la API primero):
  ```bash
  docker compose -f docker-compose.prod.yml stop api web
  docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U postgres -d aguamata --clean --if-exists < backups/aguamata-AAAAMMDD-HHMMSS.dump
  docker compose -f docker-compose.prod.yml start api web
  ```
  Haz una restauración de prueba antes de abrir al público.

## Comandos útiles

```bash
C="docker compose -f docker-compose.prod.yml"
$C logs -f api                        # log de la API (incluye la revisión diaria del cobro, a las 6:00)
$C logs -f caddy                      # certificados y tráfico
$C exec postgres psql -U postgres -d aguamata
$C restart api
```

## Problemas comunes

| Síntoma | Causa probable |
|---|---|
| La API se reinicia en bucle | Configuración incompleta. Mira `logs api`: lista lo que falta. |
| `ERR_SSL` en un subdominio | El acueducto no existe con ese slug, o el DNS comodín no apunta al VPS. |
| No llegan correos | `MAIL_FROM` sin verificar, o SES todavía en modo sandbox. |
| Mercado Pago no confirma pagos | Webhook mal registrado, o `MP_WEBHOOK_SECRET` distinto. El pago también se confirma cuando el usuario vuelve a la página. |
| Falta memoria al compilar | VPS con menos de 4 GB: agrega swap o compila las imágenes en otro equipo. |
