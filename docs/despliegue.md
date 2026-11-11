# Despliegue en producción

Guía para publicar AguaMata. **Para un VPS con Docker, sigue [deploy/README.md](../deploy/README.md)**: incluye las imágenes, Caddy, los respaldos y un script de despliegue, y ya lo hace todo. Este documento explica las piezas y todas las variables. La API revisa su configuración al arrancar: en producción (`NODE_ENV=production`), si falta algo crítico **no arranca** y lista lo que falta. La web hace lo mismo al compilar.

## Piezas

| Pieza | Qué es | Notas |
|---|---|---|
| PostgreSQL 16 | Base de datos | Con copias de respaldo diarias. Dos roles (ver abajo). |
| Redis 7 | Cola de tareas | Revisión diaria del cobro, PDF masivos, importaciones, factura electrónica. Con persistencia (AOF). |
| API (NestJS) | `apps/api` | `pnpm --filter @agua-mata/api build` y luego `node dist/main.js`. El worker de la cola corre en el mismo proceso. |
| Web (Next.js) | `apps/web` | `pnpm --filter @agua-mata/web build` y luego `next start`. Reenvía `/api/v1` a la API. |
| Proxy con HTTPS | Caddy (recomendado) o Nginx | Debe servir `aguamata.co`, `*.aguamata.co` (un subdominio por acueducto) y los dominios propios verificados. |
| Correo | Amazon SES o SMTP | Remitente verificado. |
| Archivos | S3 o compatible (R2, MinIO) | O un volumen persistente con respaldo. |

## Pasos

1. **Base de datos.** Con un superusuario, crea la base `aguamata` y los roles:
   ```bash
   psql "postgresql://<admin>@<host>:5432/aguamata" \
     -v owner_password='<clave fuerte 1>' -v app_password='<clave fuerte 2>' \
     -f infra/postgres/production-roles.sql
   ```
   - `aguamata_owner`: dueño de las tablas, con `BYPASSRLS`. Solo lo usan las migraciones y el seed.
   - `aguamata_app`: el que usa la API. **No** puede saltarse RLS, y por eso cada acueducto solo ve sus datos.
   - Crear un rol con `BYPASSRLS` requiere superusuario. En algunos servicios administrados (RDS, Cloud SQL) no se permite; ahí conviene una base propia o un proveedor que lo admita.
2. **Compilar:** `pnpm install --frozen-lockfile && pnpm build`. La web necesita sus variables (ver abajo) **al compilar**.
3. **Migraciones:** `pnpm --filter @agua-mata/api prisma:deploy`. Usa `DIRECT_DATABASE_URL`.
4. **Seed:** `NODE_ENV=production SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... pnpm db:seed`. Crea el plan, el catálogo regulatorio y el superadmin. Se niega a usar la contraseña de desarrollo.
5. **Arrancar** la API y la web detrás del proxy. Revisa el log de la API: los avisos de `[Config]` dicen qué conviene completar.
6. **Superadmin:** entra a `https://<plataforma>/admin/cobros` y define el precio del plan, la cuenta para transferencias y los plazos.
7. **Mercado Pago:** registra el webhook `https://<api pública>/api/v1/public/payments/mercadopago/webhook` (evento *Pagos*) y copia la clave secreta en `MP_WEBHOOK_SECRET`.

## DNS y HTTPS

- `aguamata.co` y `*.aguamata.co` → el servidor. El comodín es para el subdominio de cada acueducto.
- `tenants.aguamata.co` → el servidor. Es el destino del CNAME de los dominios propios de los acueductos.
- Certificados: el comodín necesita validación por DNS. Los dominios propios usan TLS bajo demanda, preguntando a `GET /api/v1/public/tls-ask?domain=` para no emitir certificados a dominios ajenos. Con Caddy es `on_demand_tls { ask ... }`.
- El proxy debe enviar `X-Forwarded-For` y `X-Forwarded-Proto`, y conservar el encabezado `Host` original hacia la web.

## Variables de la API (`apps/api/.env`)

**Obligatoria** = sin ella la API no arranca en producción.

| Variable | Obligatoria | Ejemplo / nota |
|---|---|---|
| `NODE_ENV` | sí | `production` (activa las revisiones) |
| `DATABASE_URL` | sí | `postgresql://aguamata_app:<clave>@db:5432/aguamata?schema=public`. **Nunca** el rol dueño. |
| `DIRECT_DATABASE_URL` | sí (migraciones y seed) | `postgresql://aguamata_owner:<clave>@db:5432/aguamata?schema=public` |
| `REDIS_URL` | sí | `redis://redis:6379` |
| `PLATFORM_WEB_ORIGIN` | sí | `https://aguamata.co`. Igual a `NEXT_PUBLIC_PLATFORM_ORIGIN` de la web. |
| `APP_ENCRYPTION_KEY` | sí | `openssl rand -base64 32`. **Guárdala aparte:** si se pierde, no se pueden descifrar las claves técnicas de la DIAN. |
| `MAIL_PROVIDER` | sí | `ses` o `smtp` (`log` no envía nada) |
| `MAIL_FROM` | sí | `AguaMata <no-responder@aguamata.co>`, verificado en el proveedor |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | con SES o S3 | O un rol IAM del servidor |
| `SES_CONFIGURATION_SET` | no | Métricas de entrega en SES |
| `SMTP_URL` o `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | con SMTP | |
| `STORAGE_DRIVER` | recomendado `s3` | `local` funciona, pero en un volumen persistente con respaldo |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | con S3 | El bucket debe ser **privado** |
| `STORAGE_DIR` | con `local` | Ruta del volumen persistente |
| `COOKIE_SECURE` | recomendado | `true` |
| `TRUST_PROXY` | recomendado | `uniquelocal` si el proxy o la web están en otros contenedores de la misma red; `loopback` si todo está en el mismo equipo |
| `API_PORT` | no | `4000` |
| `MP_ACCESS_TOKEN` | no | `APP_USR-...`. Sin él, solo se ofrece la transferencia. |
| `MP_WEBHOOK_SECRET` | con Mercado Pago | Clave secreta del webhook |
| `API_PUBLIC_URL` | con Mercado Pago | `https://api.aguamata.co`: URL pública de la API para el webhook |
| `QUEUE_NAME`, `WORKER_ENABLED`, `WORKER_CONCURRENCY` | no | Para separar el worker en otro proceso: `WORKER_ENABLED=false` en la API y `true` en el worker |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` | solo para el seed | Contraseña de 12 caracteres o más |

## Variables de la web (`apps/web`, al compilar)

Las tres quedan **fijas en la compilación**: si cambian, hay que volver a compilar. Sin ellas, `next build` en producción falla.

| Variable | Ejemplo |
|---|---|
| `NEXT_PUBLIC_PLATFORM_ORIGIN` | `https://aguamata.co` |
| `NEXT_PUBLIC_API_URL` | `/api/v1` (déjala relativa) |
| `API_INTERNAL_URL` | `http://api:4000`: dirección **interna** de la API, vista desde la web |

## Antes de abrir al público

- [ ] Copias de respaldo automáticas de PostgreSQL, y una restauración de prueba hecha.
- [ ] `APP_ENCRYPTION_KEY` y las contraseñas de los roles guardadas en un gestor de secretos.
- [ ] Remitente de correo verificado (SPF, DKIM y DMARC del dominio).
- [ ] Webhook de Mercado Pago registrado y probado con un pago real pequeño.
- [ ] Precio del plan y cuenta para transferencias configurados en `/admin/cobros`.
- [ ] El log de la API arranca sin avisos de `[Config]`, o con los que aceptas conscientemente.
- [ ] Validación legal pendiente: catálogo regulatorio, topes de subsidio, tasas de interés y tipo de documento electrónico.
