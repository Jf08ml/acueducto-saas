# Visión estratégica: plataforma SaaS multi-tenant

> Documento fundacional. Todas las decisiones técnicas del proyecto deben ser compatibles con él.
> Fecha: 2026-11-05

**Objetivo:** un producto SaaS vertical para la administración integral de acueductos en Colombia (acueductos comunitarios, asociaciones de usuarios, gestores comunitarios de agua), vendido por suscripción mensual o anual. El acueducto piloto es solo el primer tenant.

---

## 1. Principios de arquitectura (decisiones adoptadas)

| # | Decisión | Detalle |
|---|----------|---------|
| A1 | **Tenant = organización (acueducto)** | Toda entidad de negocio lleva `organization_id NOT NULL` con FK e índice compuesto que empieza por `organization_id`. |
| A2 | **Base compartida + Row Level Security** | PostgreSQL con RLS activado en todas las tablas de tenant. El backend fija `app.current_org` por transacción y las políticas filtran por él. Hay doble barrera: validación en backend **y** política en la BD. |
| A3 | **Plano de control separado** | Las tablas de plataforma (organizaciones, planes, suscripciones, pagos SaaS, soporte, anuncios, auditoría) van en un esquema `platform`, separado de los datos operativos en el esquema `tenant`. |
| A4 | **El superadmin no ve datos privados** | El rol de plataforma solo accede a metadatos y métricas agregadas (p. ej., número de suscriptores). Para ver datos de un tenant hace falta una **sesión de soporte**: la solicita soporte, la aprueba el administrador del tenant, tiene alcance limitado, expira sola (TTL) y queda auditada. |
| A5 | **Entitlements, no código condicional** | Planes → módulos y límites guardados como datos (`plan_features`, `plan_limits`, `org_overrides`). El código pregunta `can(org, feature)` y `limit(org, key)`. Crear un plan nuevo no requiere desplegar. |
| A6 | **Dos facturaciones separadas** | La facturación SaaS (plataforma → acueducto) vive en `platform.*`. La facturación del agua (acueducto → suscriptor) vive en `tenant.*`. No comparten tablas ni numeración. |
| A7 | **Configuración por tenant** | Branding, plantillas, tarifas, períodos y formatos se guardan por `organization_id`. Los recursos (logo, plantillas) se guardan bajo el prefijo `orgs/{org_id}/`. |
| A8 | **Trabajo asíncrono** | Una cola de trabajos (facturación masiva, PDFs, importaciones de Excel, notificaciones) con `organization_id` en cada trabajo y cuotas por tenant. |
| A9 | **Auditoría inmutable** | Una tabla append-only con actor, organización, acción, entidad, antes/después, IP y fecha. Cubre las acciones de plataforma y las de tenant. |
| A10 | **Pruebas de aislamiento obligatorias** | Una suite en CI crea dos tenants y verifica que ningún endpoint ni consulta filtra datos cruzados, incluido el acceso directo a la BD sin contexto. |

## 2. Módulos por tenant

Información institucional · Suscriptores · Medidores y lecturas · Tarifas · Facturación · Recaudos · Cartera · Contabilidad · Documentación · Personal y usuarios · Configuración · Reportes.

## 3. Panel Superadmin

- Alta y gestión de organizaciones; activar, suspender y desactivar.
- Suscriptores por organización (solo el conteo).
- Planes, límites, funcionalidades y promociones.
- Suscripciones, pagos, vencimientos y períodos de gracia.
- Métricas de uso, soporte (tickets y sesiones de soporte), auditoría, anuncios.

## 4. Planes y monetización

- Planes semilla: **Gratuito, Básico, Profesional, Avanzado, Personalizado**.
- Límites configurables: suscriptores, usuarios administrativos, almacenamiento, módulos, documentos generados por mes, automatizaciones, integraciones.
- Ciclo de vida: `trial → active → past_due (gracia) → suspended → cancelled`, con renovación automática, pagos recurrentes y cambio de plan (upgrade/downgrade con prorrateo).
- Comportamiento al superar un límite: avisar al 80 %, bloquear solo la creación de recursos nuevos (nunca la lectura ni la exportación).

## 5. Onboarding de un acueducto (asistente)

1. Datos institucionales: nombre, razón social, NIT (con dígito de verificación), departamento y municipio (DIVIPOLA).
2. Perfil jurídico: tipo de organización, naturaleza jurídica y tipo de prestador, que determinan los **módulos y obligaciones regulatorias** que se activan.
3. Tamaño: número aproximado de suscriptores, que sugiere un plan.
4. Contacto y datos de facturación SaaS.
5. Información tarifaria y período de facturación.
6. Branding (logo, colores).
7. Importación de suscriptores desde Excel: plantilla descargable, validación previa, reporte de errores y ejecución en segundo plano.

## 6. Personalización por organización

Logo, colores, nombre institucional, contacto, plantillas de recibo, tarifas, períodos de facturación y formatos de documentos. Todo queda aislado por tenant.

## 7. Escalabilidad

Arquitectura modular (monolito modular primero, con fronteras claras), multi-tenancy seguro, cola de trabajos, almacenamiento de objetos, backups con **exportación y restauración por tenant**, monitoreo centralizado con `org_id` en logs y métricas, cuotas de consumo por tenant, API versionada (`/api/v1`) con API keys por organización, y migraciones versionadas y reversibles.

## 8. Stack (decidido 2026-11-05)

- Backend: NestJS + Prisma + PostgreSQL 16 (RLS). Frontend: Next.js. Monorepo pnpm con paquete `shared` (Zod).
- Cola de trabajos: BullMQ + Redis (Redis ya está en docker-compose; la cola aún no está implementada).

## 9. Pendiente de decidir

- Hosting.
- Pasarela de pagos para el cobro SaaS (p. ej., Wompi, PayU, Mercado Pago).
- Facturación electrónica DIAN (para la facturación SaaS y la de los acueductos).
- Catálogo regulatorio por tipo de prestador (SSPD, CRA, SUI).
