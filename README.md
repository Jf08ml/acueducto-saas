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
- En la migración: `SELECT tenant.enable_rls('tenant.<tabla>');`
- Acceso solo vía `prisma.tenant` en rutas `@TenantScoped()`. Al crear, tomar `organizationId` de `currentContext()`, nunca del cuerpo de la petición.
- La prueba "TODA tabla del esquema tenant tiene RLS" falla si olvidas el paso de RLS.

### Planes y límites

Los planes, módulos y límites viven en `platform.plans`, `plan_features`, `plan_limits` y `org_entitlement_overrides`.
En código se usa `EntitlementsService.assertFeature()` y `assertWithinLimit()`. Un plan nuevo es un cambio de datos, no de código.
