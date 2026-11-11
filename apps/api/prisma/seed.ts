/**
 * Datos semilla de la PLATAFORMA (planes y superadmin). Corre con el rol dueño (DIRECT_DATABASE_URL).
 * Los precios son de referencia y se cambian desde la BD/panel, no desde el código.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });

const ALL = ['subscribers', 'meters', 'billing', 'payments', 'receivables', 'accounting', 'documents', 'reports', 'automations', 'integrations', 'excel_import', 'custom_domain'];
const CORE = ['subscribers', 'meters', 'billing', 'payments', 'receivables', 'reports'];

/**
 * Por ahora hay UN solo plan con toda la plataforma. Los planes anteriores se conservan inactivos
 * (pueden tener historial) y se pueden reactivar como datos si algún día se vuelve a vender por niveles.
 */
const UNLIMITED = { max_subscribers: -1, max_admin_users: -1, storage_mb: -1, documents_per_month: -1, automations: -1, integrations: -1 };
const PLANS: { code: string; name: string; monthly: number; yearly: number; trialDays: number; isPublic?: boolean; isActive?: boolean; features: string[]; limits: Record<string, number> }[] = [
  { code: 'plataforma', name: 'Plataforma completa', monthly: 150_000, yearly: 1_500_000, trialDays: 30, features: ALL, limits: UNLIMITED },
];
const LEGACY_PLANS = [
  { code: 'free', name: 'Gratuito', monthly: 0, yearly: 0, trialDays: 0, features: CORE,
    limits: { max_subscribers: 50, max_admin_users: 1, storage_mb: 100, documents_per_month: 100, automations: 0, integrations: 0 } },
  { code: 'basic', name: 'Básico', monthly: 89_000, yearly: 890_000, trialDays: 30, features: [...CORE, 'documents', 'excel_import'],
    limits: { max_subscribers: 300, max_admin_users: 3, storage_mb: 1024, documents_per_month: 1000, automations: 2, integrations: 0 } },
  { code: 'pro', name: 'Profesional', monthly: 189_000, yearly: 1_890_000, trialDays: 30, features: [...CORE, 'documents', 'excel_import', 'accounting', 'automations', 'custom_domain'],
    limits: { max_subscribers: 1500, max_admin_users: 8, storage_mb: 5120, documents_per_month: 10000, automations: 10, integrations: 2 } },
  { code: 'advanced', name: 'Avanzado', monthly: 389_000, yearly: 3_890_000, trialDays: 30, features: ALL,
    limits: { max_subscribers: 5000, max_admin_users: 25, storage_mb: 20480, documents_per_month: -1, automations: -1, integrations: 10 } },
  { code: 'custom', name: 'Personalizado', monthly: 0, yearly: 0, trialDays: 0, isPublic: false, features: ALL,
    limits: { max_subscribers: -1, max_admin_users: -1, storage_mb: -1, documents_per_month: -1, automations: -1, integrations: -1 } },
];
void LEGACY_PLANS;

/**
 * Catálogo regulatorio ORIENTATIVO. Debe validarlo un asesor en servicios públicos antes de salir a producción.
 * appliesTo vacío = aplica a todos los prestadores.
 */
const OBLIGATIONS = [
  { code: 'rups', title: 'Inscripción y actualización en el RUPS', authority: 'SSPD', legalBasis: 'Ley 142 de 1994',
    frequency: 'Inscripción inicial y actualización anual',
    description: 'Registro Único de Prestadores de Servicios Públicos ante la Superintendencia de Servicios Públicos Domiciliarios.', appliesTo: {} },
  { code: 'sui', title: 'Reporte de información al SUI', authority: 'SSPD', legalBasis: 'Ley 142 de 1994; Ley 689 de 2001',
    frequency: 'Según calendario de cargue de la SSPD',
    description: 'Cargue de información comercial, técnica, administrativa y financiera en el Sistema Único de Información.', appliesTo: {} },
  { code: 'ccu', title: 'Contrato de condiciones uniformes', authority: 'CRA', legalBasis: 'Ley 142 de 1994, arts. 128 a 131',
    frequency: 'Adopción inicial y actualización cuando cambien las condiciones',
    description: 'Contrato de servicios públicos que regula la relación con los suscriptores; debe estar disponible para ellos.', appliesTo: {} },
  { code: 'tarifa_pequenos', title: 'Estudio de costos y tarifas (pequeños prestadores)', authority: 'CRA',
    legalBasis: 'Resolución CRA 825 de 2017', frequency: 'Al adoptar la tarifa y en sus actualizaciones',
    description: 'Metodología tarifaria para prestadores con hasta 5.000 suscriptores.', appliesTo: { maxSubscribers: 5000 } },
  { code: 'tarifa_grandes', title: 'Estudio de costos y tarifas (más de 5.000 suscriptores)', authority: 'CRA',
    legalBasis: 'Resolución CRA 688 de 2014', frequency: 'Al adoptar la tarifa y en sus actualizaciones',
    description: 'Metodología tarifaria para prestadores con más de 5.000 suscriptores en área urbana.', appliesTo: { minSubscribers: 5001 } },
  { code: 'esquema_rural', title: 'Esquema diferencial para zona rural', authority: 'MVCT',
    legalBasis: 'Decreto 1898 de 2016 (compilado en el Decreto 1077 de 2015)', frequency: 'Al adoptarlo',
    description: 'Condiciones diferenciales de prestación del servicio en zonas rurales.', appliesTo: { areaTypes: ['rural', 'mixta'] } },
  { code: 'concesion_aguas', title: 'Concesión de aguas vigente', authority: 'Autoridad ambiental (CAR)',
    legalBasis: 'Decreto 1076 de 2015', frequency: 'Trámite inicial y renovación antes del vencimiento',
    description: 'Permiso de la autoridad ambiental para captar agua de la fuente abastecedora.', appliesTo: {} },
  { code: 'tasa_uso_agua', title: 'Pago de la tasa por utilización de agua', authority: 'Autoridad ambiental (CAR)',
    legalBasis: 'Decreto 1076 de 2015', frequency: 'Según la facturación de la autoridad ambiental',
    description: 'Tasa que cobra la autoridad ambiental por el uso del recurso hídrico.', appliesTo: {} },
  { code: 'pueaa', title: 'Programa de Uso Eficiente y Ahorro del Agua (PUEAA)', authority: 'Autoridad ambiental (CAR)',
    legalBasis: 'Ley 373 de 1997', frequency: 'Formulación y seguimiento periódico',
    description: 'Programa quinquenal de uso eficiente y ahorro del agua asociado a la concesión.', appliesTo: {} },
  { code: 'calidad_agua', title: 'Control de calidad del agua para consumo humano (IRCA)', authority: 'Secretaría de Salud',
    legalBasis: 'Decreto 1575 de 2007; Resolución 2115 de 2007', frequency: 'Muestreos periódicos según población atendida',
    description: 'Control y vigilancia de la calidad del agua y cálculo del Índice de Riesgo de Calidad del Agua.', appliesTo: {} },
  { code: 'control_social', title: 'Comité de Desarrollo y Control Social', authority: 'Municipio / SSPD',
    legalBasis: 'Ley 142 de 1994, art. 62', frequency: 'Conformación y elección de vocal de control',
    description: 'Espacio de participación de los suscriptores para el control de la prestación del servicio.', appliesTo: {} },
  { code: 'subsidios_fsri', title: 'Convenio de subsidios con el municipio (FSRI)', authority: 'Municipio',
    legalBasis: 'Ley 142 de 1994, art. 89', frequency: 'Anual',
    description: 'Convenio para el giro de subsidios del Fondo de Solidaridad y Redistribución de Ingresos.', appliesTo: {} },
  { code: 'registro_esal', title: 'Registro como entidad sin ánimo de lucro y RUT', authority: 'Cámara de Comercio / DIAN',
    legalBasis: 'Decreto 2150 de 1995', frequency: 'Inscripción inicial y renovación anual',
    description: 'Inscripción de la entidad en la Cámara de Comercio y actualización del RUT.', appliesTo: { legalNatures: ['sin_animo_lucro'] } },
];

async function main() {
  for (const [i, o] of OBLIGATIONS.entries()) {
    await prisma.regulatoryObligation.upsert({
      where: { code: o.code },
      update: {},
      create: { ...o, sortOrder: i },
    });
  }

  for (const p of PLANS) {
    const plan = await prisma.plan.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, name: p.name, priceMonthlyCop: p.monthly, priceYearlyCop: p.yearly, trialDays: p.trialDays, isPublic: p.isPublic ?? true, isActive: p.isActive ?? true },
    });
    for (const f of ALL) {
      await prisma.planFeature.upsert({
        where: { planId_featureKey: { planId: plan.id, featureKey: f } },
        update: {},
        create: { planId: plan.id, featureKey: f, enabled: p.features.includes(f) },
      });
    }
    for (const [k, v] of Object.entries(p.limits)) {
      await prisma.planLimit.upsert({
        where: { planId_limitKey: { planId: plan.id, limitKey: k } },
        update: {},
        create: { planId: plan.id, limitKey: k, value: v },
      });
    }
  }

  await prisma.plan.updateMany({ where: { code: { notIn: PLANS.map((p) => p.code) } }, data: { isActive: false, isPublic: false } });

  const email = (process.env.SUPERADMIN_EMAIL ?? 'admin@aguamata.local').toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD ?? 'Admin12345!';
  if (process.env.NODE_ENV === 'production' && (!process.env.SUPERADMIN_EMAIL || !process.env.SUPERADMIN_PASSWORD || password === 'Admin12345!' || password.length < 12)) {
    throw new Error('En producción define SUPERADMIN_EMAIL y SUPERADMIN_PASSWORD (mínimo 12 caracteres, distinta a la de desarrollo) antes del seed');
  }
  await prisma.user.upsert({
    where: { email },
    update: { isPlatformAdmin: true },
    create: { email, fullName: 'Administrador de plataforma', passwordHash: await bcrypt.hash(password, 10), isPlatformAdmin: true },
  });
  console.log(`Seed listo: ${PLANS.length} planes, superadmin ${email}`);
}

main().finally(() => prisma.$disconnect());
