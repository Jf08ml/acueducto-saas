# AguaMata

SaaS multi-tenant para la administración integral de acueductos en Colombia.
Visión y decisiones de arquitectura: [docs/01-vision-saas-multitenant.md](docs/01-vision-saas-multitenant.md).

## Estructura

```
apps/api         NestJS + Prisma (API REST /api/v1)
apps/web         Next.js (panel del acueducto, registro, panel Superadmin)
packages/shared  Validaciones Zod, NIT/DV, catálogo de módulos y límites
infra/postgres   Roles de base de datos (se ejecuta al crear el contenedor)
```

## Arranque local

Requisitos: Node 22+, pnpm 10, Docker Desktop.

```bash
pnpm install
pnpm infra:up                              # PostgreSQL (puerto 5433) y Redis (6380)
cp apps/api/.env.example apps/api/.env     # si no existe
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @agua-mata/shared build
pnpm --filter @agua-mata/api prisma:deploy
pnpm db:seed                               # 5 planes + superadmin
pnpm dev                                   # API :4000 · Web :3000
```

- La web reenvía `/api/v1` a la API (`API_INTERNAL_URL`), así que el navegador solo habla con :3000. Si tu `apps/web/.env.local` es antiguo, pon `NEXT_PUBLIC_API_URL="/api/v1"`.
- Superadmin de desarrollo: `admin@aguamata.local` / `Admin12345!`
- Registrar un acueducto: http://localhost:3000/registro

## Despliegue

- **VPS con Docker:** [deploy/README.md](deploy/README.md). Imágenes de la API y la web, PostgreSQL, Redis, Caddy (HTTPS automático, también para subdominios y dominios propios), respaldos diarios y `deploy.sh`.
- **Referencia:** [docs/despliegue.md](docs/despliegue.md). Piezas, DNS y HTTPS, todas las variables de entorno y la lista de verificación.
Con `NODE_ENV=production`, la API no arranca si falta configuración crítica, y la web no compila sin sus variables.

## Datos de demostración

Simulan cuatro meses de operación (julio a octubre de 2026) en un acueducto ya registrado. Se cargan por la API real, así que facturas, subsidios, intereses, abonos y cartera salen calculados como en el uso normal.

```bash
pnpm db:demo                       # carga la demo en "agua-mata" (con pnpm dev corriendo)
pnpm db:demo -- --reset            # la borra y deja el acueducto como estaba
pnpm db:demo -- --org=<slug>       # en otro acueducto
```

- **Incluye:**
  - Una tarifa con subsidios y contribuciones, y la configuración de cobro: intereses de mora, reconexión y lista de suspensión.
  - 22 suscriptores con medidor (dos sin medidor, facturados por aforo) y cuatro facturaciones.
  - Pagos puntuales, tardíos, abonos parciales y morosos, y un pago anulado.
  - Cargos adicionales, una suspensión, una reconexión con su cargo y anomalías de lectura (fuga, consumo cero, predio cerrado, medidor dañado).
  - Obligaciones con avance y un equipo de demostración.
- **Usuarios de la demo** (contraseña `Demo12345!`): `laura.gomez@demo.aguamata.co` (administradora) y `carlos.ruiz@demo.aguamata.co` (operador).
- **Cómo se reconoce:** los suscriptores usan los códigos 0101 a 0199 y los usuarios, correos `@demo.aguamata.co`.
- **Qué borra `--reset`:** toda la facturación, el recaudo, las lecturas y los medidores del acueducto, y los suscriptores y usuarios de la demo. Restaura la tarifa anterior. La bitácora de auditoría no se borra.

## Pruebas

```bash
pnpm test     # incluye la prueba de aislamiento entre tenants contra la BD real
```

## Cómo funciona el aislamiento (lectura obligatoria antes de agregar módulos)

1. **Dos roles de BD.** `aguamata_owner` es dueño de las tablas y solo se usa en migraciones y seed.
   La API se conecta como `aguamata_app`, que **no** puede saltarse RLS.
2. **Dos esquemas.** `platform.*` es el plano de control del SaaS. `tenant.*` guarda los datos de los acueductos, y toda tabla allí lleva `organization_id` y RLS.
3. **Contexto por petición.** `TenantGuard` revalida la membresía en cada petición y fija la organización.
   `prisma.tenant` envuelve cada consulta en una transacción con `set_config('app.current_org', …)`.
   Sin organización en el contexto, RLS devuelve 0 filas (falla cerrado).
4. **El Superadmin** usa `prisma.platform` y rutas `@PlatformAdmin()`: no fija tenant, así que no ve datos de acueductos.
   Las métricas salen de funciones `SECURITY DEFINER` que solo devuelven agregados.
5. **Acceso de soporte:** la única excepción, y solo si el acueducto la aprueba (ver «Acceso de soporte y auditoría»).

### Checklist para una tabla nueva de tenant

- Modelo con `@@schema("tenant")`, `organizationId` y relación a `Organization`.
- Índices y `@@unique` que empiecen por `organizationId`.
- Si referencia otra tabla de tenant, declara la relación **compuesta** en `schema.prisma`:
  `@relation(fields: [xId, organizationId], references: [id, organizationId], map: "..._same_org_fkey")`, más
  `@@unique([id, organizationId])` en la tabla referenciada. No las agregues solo en SQL: Prisma intentaría borrarlas en la siguiente migración.
- En la migración: `SELECT tenant.enable_rls('tenant.<tabla>');`
- Si `prisma migrate dev` pide confirmación interactiva, genera el SQL con
  `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`,
  revísalo y aplícalo con `prisma migrate deploy`.
- Acceso solo vía `prisma.tenant` en rutas `@TenantScoped()`. Al crear, tomar `organizationId` de `currentContext()`, nunca del cuerpo de la petición.
- La prueba "TODA tabla del esquema tenant tiene RLS" falla si olvidas el paso de RLS.

### Asistente de configuración inicial (`/configuracion`)

Después de registrarse, el acueducto completa estos pasos. Los dos primeros son obligatorios para activar la cuenta.

1. **Perfil regulatorio:** naturaleza jurídica, tipo de prestador (Ley 142, art. 15), zona, altitud y número de suscriptores.
   Con estos datos se genera la lista de obligaciones a partir de `platform.regulatory_obligations`, un catálogo **orientativo** que debe validar un asesor.
2. **Tarifa:** cargo fijo, valores por m³ (básico, complementario, suntuario), consumo básico sugerido según la altitud y subsidios y contribuciones por estrato, validados contra los topes legales.
3. **Marca:** colores, pie de recibo y logo (PNG, JPG o WEBP; se revisa el tipo real del archivo, no solo la extensión).
4. **Importación desde Excel:** plantilla descargable, revisión previa con reporte por fila e importación todo o nada que respeta el límite del plan.

### Dominios por acueducto

- **Por defecto**, cada acueducto vive en `{slug}.{dominio de la plataforma}` (en desarrollo: `http://{slug}.localhost:3000`).
  El slug sale del nombre al registrarse y nunca usa palabras reservadas (`www`, `admin`, `api`…).
- **Dominio propio** (plan Profesional o superior): el acueducto lo agrega en *Configuración → Dominio* y crea dos registros DNS:
  - `TXT _aguamata-verify.<dominio>` con el token, para demostrar que el dominio es suyo.
  - `CNAME <dominio>` apuntando a `tenants.<dominio de la plataforma>`, para dirigir el tráfico.
  Solo los dominios **verificados** resuelven, quedan permitidos en CORS y reciben certificado TLS.
- En la dirección de un acueducto, el login muestra su marca y solo admite usuarios de **ese** acueducto.
  `/registro` y `/admin` solo existen en el dominio de la plataforma.
- `GET /api/v1/public/tls-ask?domain=` responde 200 únicamente para hosts válidos. Sirve como endpoint `ask` del
  TLS bajo demanda del proxy (por ejemplo Caddy `on_demand_tls`), para no emitir certificados a dominios ajenos.
- Variables: `PLATFORM_WEB_ORIGIN` (API) y `NEXT_PUBLIC_PLATFORM_ORIGIN` (web).

### Medidores y lecturas

- Un medidor activo por suscriptor. Las FK compuestas `(id, organization_id)` impiden enlazar registros entre acueductos,
  porque las FK de Postgres no pasan por RLS.
- Una lectura por medidor y período (`AAAA-MM`). La lectura anterior es el último valor realmente leído.
- Sin lectura (predio cerrado, medidor dañado…), se registra la causal y el consumo se estima con el promedio (Ley 142, art. 146).
- Se marcan para revisión: lectura menor a la anterior (no se factura consumo negativo), consumo cero y consumo mayor
  al doble del promedio (desviación significativa, Ley 142, art. 149).
- No se puede corregir un período si ya hay lecturas posteriores o si el período ya se facturó (`locked`).

### Facturación del agua

Flujo: **Facturación → Facturar período → previsualización → Emitir**. Nada se guarda antes de emitir.

- **Cálculo** (`computeInvoice` en `packages/shared/src/billing.ts`, con pruebas unitarias):
  cargo fijo, consumo por rangos (básico hasta el consumo básico, complementario hasta el umbral suntuario
  y suntuario por encima; el umbral es configurable y por defecto vale 2 × básico),
  **subsidio** sobre cargo fijo y consumo básico (estratos 1 a 3) y **contribución** sobre todo el servicio
  (estratos 5 y 6, comercial, industrial). Se redondea al peso. Los residenciales usan el factor de su estrato y los demás usos, el de su tipo.
- **Medidores sin lectura:** por defecto la emisión se bloquea; también se puede facturar solo el cargo fijo.
  A los suscriptores sin medidor se les cobra el aforo (m³) que se indique, o solo el cargo fijo.
- **Emisión atómica:** todas las facturas del período se crean en una sola transacción con RLS (`tenantTransaction`).
  La numeración es consecutiva por acueducto y las lecturas del período quedan bloqueadas.
- **Copia de datos:** la factura guarda una copia de los datos del suscriptor y de la lectura. Editar al suscriptor después no la cambia.
- **Anulación:** requiere motivo, solo es posible si ninguna factura tiene pagos, libera las lecturas y permite reemitir con números nuevos. Los anteriores no se reutilizan.
- **Recibos:** `/facturacion/recibo?id=` y `/facturacion/recibos?p=AAAA-MM` (todos los del período), con la marca del acueducto,
  historial de consumo y estilos de impresión.
- **PDF en el servidor** (pdfkit, sin navegador): `GET /invoices/:id/pdf` descarga un recibo al instante.
  `POST /billing/periods/:period/receipts/pdf` genera los del período como tarea en la cola (un recibo por página) y se descarga con `GET /jobs/:id/file`.
  El archivo queda en el almacenamiento del acueducto; el logo sale si es PNG o JPG.
- **Saldo anterior:** al emitir, cada factura guarda lo que el suscriptor debía de facturas previas. El recibo lo muestra
  y el «Total a pagar» lo incluye. Es informativo: la cartera se calcula siempre factura por factura, así no hay doble conteo.

### Facturación electrónica (base)

Deja listo el flujo; **todavía no está conectada a la DIAN**. Solo hay un proveedor **simulado** (habilitación), sin validez.

- **Configuración** (*Configuración → Factura electrónica*, `tenant.einvoice_configs` con RLS):
  - Tipo de documento: documento equivalente de SPD o factura de venta.
  - Ambiente y proveedor. El simulado no se puede usar en producción.
  - Resolución de numeración: número, fecha, prefijo, rango y vigencia.
  - Clave técnica, **cifrada** con AES-256-GCM (`APP_ENCRYPTION_KEY`). La API nunca la devuelve.
- **Flujo:** al emitir un período, si está activa, se encola `einvoice.send_period`:
  1. Numera las facturas del período con el rango autorizado, **todo o nada**, bajo bloqueo por acueducto: sin huecos ni repetidos. Si el rango no alcanza o la resolución no está vigente, no numera ninguna y la tarea informa el motivo.
  2. Arma un documento neutro (`buildEInvoicePayload` en `packages/shared/src/einvoice.ts`) y lo envía al proveedor.
  3. Guarda el CUFE/CUDE, el QR o el error (`tenant.einvoice_documents`, uno por factura).
- Lo que falla se reintenta desde la página del período («Enviar pendientes») y conserva su número.
- El recibo, en pantalla y en PDF, muestra el número electrónico y el CUFE/CUDE cuando fue aceptado.
- **Anular** un período: lo no enviado queda anulado; lo ya aceptado queda «requiere nota crédito».
- **Para conectar un proveedor real:** implementar `EInvoiceProvider` (`apps/api/src/einvoice/einvoice.module.ts`) con su API y registrarlo en `PROVIDERS`. El proveedor firma, arma el XML UBL 2.1 y transmite a la DIAN.
- **Pendiente:** proveedor real, notas crédito y débito, y la validación con un asesor tributario del tipo de documento y el calendario que aplican a cada acueducto (Resolución DIAN 000165 de 2023, orientativo).

### Recaudo y cartera

- **Pago:** se busca al suscriptor por la referencia del recibo (`código-número`), el código, el documento o el nombre.
  El pago se abona primero a la factura más antigua (`allocateFifo`) y puede ser parcial. Cada pago recibe un comprobante con numeración consecutiva.
  No se reciben anticipos: un pago mayor que la deuda se rechaza.
- **Concurrencia:** pagos, anulaciones de pagos, emisión y anulación de facturación toman un bloqueo transaccional por acueducto
  (`pg_advisory_xact_lock`). Dos cajeros no pueden aplicar dos veces la misma deuda ni repetir un número (hay una prueba con pagos simultáneos).
- **Integridad en la BD:** montos positivos, `paid_amount` entre 0 y el total de la factura, y FK compuestas en las aplicaciones de pago.
- **Anular un pago:** requiere motivo y devuelve el saldo a las facturas. Una facturación con abonos no se puede anular sin anular antes esos pagos.
- **Cartera:** se calcula a una fecha de corte, por edades (corriente, 1–30, 31–60, 61–90, más de 90 días), con estado de cuenta por suscriptor.
- **Lista de suspensión:** suscriptores con N o más facturas vencidas (N lo elige el acueducto). La Ley 142, art. 140
  (modificado por la Ley 689 de 2001), fija el máximo en 3 períodos para facturación mensual y 2 para bimestral.

### Intereses de mora, cargos, suspensión y reconexión

Se configuran en *Configuración → Cobro* (`collectionSettings` de la organización).

- **Intereses de mora** (desactivados por defecto): interés simple mensual, prorrateado por días, con tasa distinta para usuarios residenciales y no residenciales y días de gracia opcionales.
  - Se calculan al emitir, hasta la fecha de expedición, y se suman como línea de la nueva factura (`interestAmount`).
  - La base es el capital vencido sin los intereses ya facturados: no hay anatocismo.
  - Cada tramo se cobra una sola vez, porque el cálculo arranca en la última factura vigente con intereses. Si se anula esa facturación, el punto de partida vuelve atrás de forma automática.
  - Orientación (validar con un asesor): para usuarios residenciales suele aplicarse la tasa civil y para no residenciales la comercial, sin superar la tasa de usura.
- **Cargos adicionales** (`subscriber_charges`): la reconexión y los cargos manuales se suman a la siguiente factura y quedan amarrados a ella.
  Un cargo facturado no se anula directamente; al anular la facturación vuelve a quedar pendiente.
- **Suspensión y reconexión** (`service_events`, `subscribers.service_status`):
  - Cada suspensión y reconexión queda en el historial con fecha, motivo, usuario y saldo en ese momento.
  - Reconectar exige estar al día (Ley 142, art. 142), salvo que se marque «con deuda» y se registre el acuerdo de pago.
  - El cargo de reconexión configurado se carga a la siguiente factura.
- La **lista de suspensión** usa el umbral configurado y excluye a quienes ya están suspendidos.

### Correo

`MAIL_PROVIDER` = `log` (por defecto: no envía), `ses` o `smtp`. Ver `apps/api/.env.example`.

- **Amazon SES** (API v2): credenciales por la cadena estándar de AWS. `MAIL_FROM` debe estar verificado en SES. `SES_CONFIGURATION_SET` es opcional.
- **SMTP**: `SMTP_URL` o `SMTP_HOST/PORT/USER/PASS/SECURE`.
- El remitente visible es el nombre del acueducto (con la dirección de `MAIL_FROM`) y la respuesta va al correo de contacto del acueducto.
- Si el proveedor falla, la operación no se rompe: se registra el error y la UI ofrece el enlace para compartirlo por WhatsApp.

### Tareas en segundo plano

- **BullMQ sobre Redis** (`JobsModule`): reintentos con espera creciente, tareas programadas (cron, hora de Colombia) y avance visible.
  - El worker corre en el proceso de la API (`WORKER_ENABLED=true`) o en uno aparte.
  - En pruebas, o con `QUEUE_DRIVER=inline`, la tarea corre en el acto y no hace falta Redis.
- Un módulo registra su tarea en `onModuleInit` con `jobs.register(tipo, handler)` y la encola con `jobs.enqueue(tipo, datos)`.
- **Aislamiento:** cada tarea corre con el tenant de quien la encoló (RLS igual que en una petición). Sin tenant, no ve datos de ningún acueducto.
- El estado, el avance y el resultado quedan en `platform.background_jobs`. La web lo sigue con `GET /jobs/:id` (`waitForJob`), solo dentro del mismo acueducto.
- Si una tarea falla, el usuario ve el mensaje solo si el error es intencional (`HttpException`); los detalles internos quedan en el log.
- Hoy corre como tarea la **importación desde Excel**: la revisión es inmediata y la importación se hace en segundo plano, todo o nada en una transacción.

### Archivos

- `STORAGE_DRIVER=local` (carpeta `STORAGE_DIR`) para desarrollo, o `s3` para producción: Amazon S3 o compatible (Cloudflare R2, MinIO, Spaces) con `S3_ENDPOINT`.
- El bucket debe ser **privado** y los objetos se cifran (SSE). Los archivos siempre se sirven a través de la API, que revisa permisos.
- Las claves empiezan por `orgs/{organizationId}/` o `platform/` y nunca se arman con texto del usuario.

### Sesiones y contraseñas

- **Sesión en cookie httpOnly** (`am_sid`): el JavaScript de la página no la puede leer. La BD (`platform.sessions`) guarda solo el hash del token.
  - La cookie es de host, `SameSite=Lax`, y `Secure` con HTTPS (o `COOKIE_SECURE=true`). Cada dirección (plataforma, subdominio, dominio propio) tiene su propia sesión.
  - Vence tras 8 horas sin uso y, como máximo, a los 7 días.
  - **Salir** revoca la sesión en el servidor. **Cambiar la contraseña** cierra las demás sesiones del usuario.
- **CSRF:** con cookie, toda petición que modifica datos debe traer `X-Requested-With: aguamata` (la web lo pone siempre). Un sitio ajeno no puede añadirlo sin pasar por CORS.
- `Authorization: Bearer <token>` también sirve (pruebas e integraciones) y no necesita ese encabezado.
- **Recuperar la contraseña** (`/recuperar`): enlace de un solo uso que vence en 60 minutos; solo se guarda su hash.
  - La respuesta es la misma exista o no el correo. Máximo 3 enlaces por usuario y hora.
  - Pedido desde la dirección de un acueducto, el enlace y el correo usan esa dirección y su marca.
  - Al usarlo se cierran **todas** las sesiones del usuario.
  - Con `MAIL_PROVIDER=log`, el enlace aparece en la consola de la API (fuera de producción).

### Acceso de soporte y auditoría

- **Soporte** (`platform.support_access_grants`). El superadmin no ve datos de un acueducto salvo que este lo apruebe:
  1. Desde *Organizaciones → Soporte*, pide acceso con motivo, alcance (solo consultar, o consultar y modificar) y duración (1 a 72 horas).
  2. Los dueños y administradores reciben un correo y responden en *Auditoría*. El plazo corre desde la aprobación.
  3. Quien lo pidió entra con una **sesión de soporte** que vence con el permiso. Su sesión de superadmin se cierra.
  4. El `TenantGuard` revisa el permiso en **cada petición** (aprobado, vigente, del mismo acueducto, de quien lo pidió). Con alcance de consulta, rechaza toda modificación.
  5. Cada petición queda en la bitácora del acueducto (`support.request`, con método y ruta, sin parámetros de búsqueda). Lo que se modifica lleva `viaSupportGrant`.
  6. El acueducto lo puede **cortar en cualquier momento**: el permiso queda revocado y las sesiones de soporte se cierran de inmediato.
- **Bitácora** (`platform.audit_logs`, solo inserción):
  - El acueducto ve la suya completa en *Auditoría*, con filtro por tipo.
  - El superadmin (`/admin/auditoria`) ve lo de la plataforma y, de cada acueducto, solo cobro, estado de la cuenta y soporte. La operación es privada.

### Usuarios del acueducto

| Rol | Puede |
|-----|-------|
| Dueño | Todo, incluido gestionar a otros dueños. |
| Administrador | Todo excepto gestionar dueños: configuración, facturación, anulaciones, usuarios. |
| Operador | Suscriptores, medidores, lecturas y registrar pagos. No factura ni anula. |
| Consulta | Solo ver. |

- **Invitaciones** (`Usuarios → Invitar persona`): enlace de un solo uso que vence en 7 días. En la BD solo se guarda el hash SHA-256 del token.
  El enlace apunta al dominio principal del acueducto (o a su subdominio).
  Mientras no haya proveedor de correo (`MailService` solo registra en el log), la UI muestra el enlace para copiarlo o compartirlo por WhatsApp.
  «Reenviar» genera un enlace nuevo y el anterior deja de servir.
- **Aceptar:** quien no tiene cuenta la crea. Quien ya tiene cuenta (de otro acueducto) confirma con su contraseña y puede cambiar de acueducto desde el menú.
- **Reglas:** nadie cambia su propio rol ni se desactiva o quita a sí mismo. Solo un dueño gestiona a otro dueño. Siempre queda al menos un dueño activo.
- **Desactivar o quitar** a alguien corta el acceso en la siguiente petición: `TenantGuard` revisa la membresía en la BD, así que un token ya emitido no sirve.
- **Límite del plan** `max_admin_users`: cuenta el personal activo más las invitaciones vigentes.
- Cada usuario puede cambiar su contraseña desde el menú.

### Planes y límites

Los planes, módulos y límites viven en `platform.plans`, `plan_features`, `plan_limits` y `org_entitlement_overrides`.
En código se usa `EntitlementsService.assertFeature()` y `assertWithinLimit()`. Un plan nuevo es un cambio de datos, no de código.

Por ahora hay **un solo plan**, `plataforma` («Plataforma completa»): todos los módulos y sin límites. Los planes anteriores quedan inactivos.

### Cobro del SaaS a los acueductos

Separado de la facturación del agua: `platform.saas_invoices`, `saas_payments` y `platform_settings`.

- **Ciclo de vida:**
  1. Al registrarse, el acueducto empieza una prueba (`trialing`, 30 días por defecto).
  2. La factura del período siguiente se emite `invoiceLeadDays` antes del corte y se avisa por correo a dueños y administradores.
  3. Si el período termina sin pago: `past_due` con `graceDays` de gracia.
  4. Al acabar la gracia: `suspended` = **solo lectura**. Se puede consultar y exportar, pero toda petición que modifica datos responde 403 `SUBSCRIPTION_READ_ONLY`, salvo las de pago (`@AllowWhenReadOnly`). No se borra ni se oculta nada.
  5. Al pagar: `active` hasta el fin del período facturado. Si estaba en solo lectura, el período nuevo arranca el día del pago.
- La lógica de fechas es pura y tiene pruebas (`subscriptionActions`, `addCycle` en `packages/shared/src/saas.ts`).
- La **revisión diaria** es una tarea programada (6:00 a. m., hora de Colombia) y es idempotente. El superadmin también la puede correr desde *Cobros*.
- **Mercado Pago (Checkout Pro):** el acueducto paga en Mercado Pago y vuelve a `/suscripcion`.
  - Un pago solo cuenta después de **consultarlo en la API** de Mercado Pago: aprobado, en COP, por el monto completo y con la referencia de esa factura.
  - Llega por webhook (`POST /public/payments/mercadopago/webhook`, firma verificada con `MP_WEBHOOK_SECRET`) y también se confirma al volver, así funciona aunque el webhook no llegue (p. ej. en localhost).
  - Idempotente: un mismo pago (`provider_payment_id` único) se registra una sola vez.
- **Transferencia:** el acueducto ve la cuenta configurada y sube el comprobante (PNG, JPG o PDF, máx. 5 MB; se revisa el tipo real del archivo).
  La factura queda «en revisión» y el superadmin la aprueba o la rechaza con motivo. Al acueducto se le avisa por correo.
- **Superadmin** (`/admin/cobros`): editar el plan (precios y días de prueba), los plazos y la cuenta bancaria; revisar comprobantes; registrar un pago manual; anular facturas.
  Desde *Organizaciones → Suscripción*, cambiar el ciclo (mensual o anual) o mover la fecha de corte (cortesía o activación manual), con motivo en la auditoría.
- **Pendiente:** factura electrónica DIAN de la plataforma a los acueductos.
