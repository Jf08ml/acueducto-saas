/**
 * Datos semilla de la PLATAFORMA (planes y superadmin). Corre con el rol dueño (DIRECT_DATABASE_URL).
 * Los precios son de referencia y se cambian desde la BD/panel, no desde el código.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });

const ALL = ['subscribers', 'meters', 'billing', 'payments', 'receivables', 'accounting', 'documents', 'reports', 'automations', 'integrations', 'excel_import'];
const CORE = ['subscribers', 'meters', 'billing', 'payments', 'receivables', 'reports'];

const PLANS = [
  { code: 'free', name: 'Gratuito', monthly: 0, yearly: 0, trialDays: 0, features: CORE,
    limits: { max_subscribers: 50, max_admin_users: 1, storage_mb: 100, documents_per_month: 100, automations: 0, integrations: 0 } },
  { code: 'basic', name: 'Básico', monthly: 89_000, yearly: 890_000, trialDays: 30, features: [...CORE, 'documents', 'excel_import'],
    limits: { max_subscribers: 300, max_admin_users: 3, storage_mb: 1024, documents_per_month: 1000, automations: 2, integrations: 0 } },
  { code: 'pro', name: 'Profesional', monthly: 189_000, yearly: 1_890_000, trialDays: 30, features: [...CORE, 'documents', 'excel_import', 'accounting', 'automations'],
    limits: { max_subscribers: 1500, max_admin_users: 8, storage_mb: 5120, documents_per_month: 10000, automations: 10, integrations: 2 } },
  { code: 'advanced', name: 'Avanzado', monthly: 389_000, yearly: 3_890_000, trialDays: 30, features: ALL,
    limits: { max_subscribers: 5000, max_admin_users: 25, storage_mb: 20480, documents_per_month: -1, automations: -1, integrations: 10 } },
  { code: 'custom', name: 'Personalizado', monthly: 0, yearly: 0, trialDays: 0, isPublic: false, features: ALL,
    limits: { max_subscribers: -1, max_admin_users: -1, storage_mb: -1, documents_per_month: -1, automations: -1, integrations: -1 } },
];

async function main() {
  for (const p of PLANS) {
    const plan = await prisma.plan.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, name: p.name, priceMonthlyCop: p.monthly, priceYearlyCop: p.yearly, trialDays: p.trialDays, isPublic: p.isPublic ?? true },
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

  const email = (process.env.SUPERADMIN_EMAIL ?? 'admin@aguamata.local').toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD ?? 'Admin12345!';
  await prisma.user.upsert({
    where: { email },
    update: { isPlatformAdmin: true },
    create: { email, fullName: 'Administrador de plataforma', passwordHash: await bcrypt.hash(password, 10), isPlatformAdmin: true },
  });
  console.log(`Seed listo: ${PLANS.length} planes, superadmin ${email}`);
}

main().finally(() => prisma.$disconnect());
