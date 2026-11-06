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

- Superadmin de desarrollo: `admin@aguamata.local` / `Admin12345!`
- Registrar un acueducto: http://localhost:3000/registro

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
  historial de consumo y estilos de impresión. El PDF se obtiene con «Guardar como PDF» del navegador.
- **Saldo anterior:** al emitir, cada factura guarda lo que el suscriptor debía de facturas previas. El recibo lo muestra
  y el «Total a pagar» lo incluye. Es informativo: la cartera se calcula siempre factura por factura, así no hay doble conteo.
- **Pendiente:** intereses de mora, cargos de reconexión, facturación electrónica DIAN y PDF generado en el servidor.

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
