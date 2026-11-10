import { z } from 'zod';

/**
 * Cobro del SaaS a cada acueducto (plano de control, separado de la facturación del agua).
 * Un solo plan por ahora ("plataforma": todo incluido). Pago con Mercado Pago o transferencia, que aprueba el superadmin.
 */

export const DEFAULT_PLAN_CODE = 'plataforma';
export const BILLING_CYCLES = ['monthly', 'yearly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];
export const CYCLE_LABEL: Record<BillingCycle, string> = { monthly: 'Mensual', yearly: 'Anual' };

export const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  trialing: 'En prueba',
  active: 'Al día',
  past_due: 'Pago pendiente',
  suspended: 'Suspendida por falta de pago',
  cancelled: 'Cancelada',
};

export const SAAS_INVOICE_STATUS_LABEL: Record<string, string> = {
  pending: 'Por pagar',
  in_review: 'Transferencia en revisión',
  paid: 'Pagada',
  void: 'Anulada',
};

export const SAAS_PAYMENT_METHOD_LABEL: Record<string, string> = {
  mercadopago: 'Mercado Pago',
  transfer: 'Transferencia',
  manual: 'Registro manual',
};

/** Suma un ciclo de facturación. Mensual respeta fin de mes (31 ene + 1 mes = 28/29 feb). */
export function addCycle(from: Date, cycle: BillingCycle, times = 1): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  const months = cycle === 'yearly' ? 12 * times : times;
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** Valor del ciclo según el plan. */
export function cyclePrice(plan: { priceMonthlyCop: number; priceYearlyCop: number }, cycle: BillingCycle) {
  return cycle === 'yearly' ? plan.priceYearlyCop : plan.priceMonthlyCop;
}

/**
 * Qué le toca hacer a una suscripción hoy (lo usa la revisión diaria). Pura y con pruebas.
 *  - invoice: emitir la factura del siguiente período (faltan `leadDays` o menos para que termine el actual).
 *  - past_due: el período terminó sin pago → entra en gracia hasta `graceEndsAt`.
 *  - suspend: se acabó la gracia sin pago → modo solo lectura.
 */
export function subscriptionActions(
  s: { status: string; currentPeriodEnd: Date; graceEndsAt: Date | null; hasOpenInvoice: boolean },
  now: Date,
  cfg: { leadDays: number; graceDays: number },
): { invoice: boolean; pastDue: Date | null; suspend: boolean } {
  const live = s.status === 'trialing' || s.status === 'active' || s.status === 'past_due' || s.status === 'suspended';
  if (!live) return { invoice: false, pastDue: null, suspend: false };
  const invoice = !s.hasOpenInvoice && addDays(s.currentPeriodEnd, -cfg.leadDays).getTime() <= now.getTime();
  const ended = s.currentPeriodEnd.getTime() <= now.getTime();
  const pastDue = ended && (s.status === 'trialing' || s.status === 'active') ? addDays(s.currentPeriodEnd, cfg.graceDays) : null;
  const graceEnd = pastDue ?? s.graceEndsAt;
  const suspend = ended && s.status !== 'suspended' && graceEnd !== null && graceEnd.getTime() <= now.getTime();
  return { invoice, pastDue, suspend };
}

const money = z.number().int().min(0).max(100_000_000);

export const saasSettingsSchema = z.object({
  /** Días antes del fin del período en que se emite la factura siguiente. */
  invoiceLeadDays: z.number().int().min(0).max(60),
  /** Días de gracia después del vencimiento antes de pasar a solo lectura. */
  graceDays: z.number().int().min(0).max(60),
  bank: z.object({
    bankName: z.string().max(80),
    accountType: z.enum(['ahorros', 'corriente']),
    accountNumber: z.string().max(40),
    holder: z.string().max(120),
    holderId: z.string().max(40),
    instructions: z.string().max(500),
  }),
});
export type SaasSettings = z.infer<typeof saasSettingsSchema>;
export const DEFAULT_SAAS_SETTINGS: SaasSettings = {
  invoiceLeadDays: 7,
  graceDays: 7,
  bank: { bankName: '', accountType: 'ahorros', accountNumber: '', holder: '', holderId: '', instructions: '' },
};

export const updatePlanSchema = z.object({
  name: z.string().min(3).max(80),
  priceMonthlyCop: money,
  priceYearlyCop: money,
  trialDays: z.number().int().min(0).max(365),
});

export const reportTransferSchema = z.object({
  reference: z.string().min(3).max(80),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(500).optional(),
});

export const manualPaymentSchema = z.object({
  method: z.enum(['transfer', 'manual']),
  reference: z.string().min(3).max(80),
  notes: z.string().max(500).optional(),
});

export const reviewTransferSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({ decision: z.literal('reject'), reason: z.string().min(5).max(300) }),
]);

export const adjustSubscriptionSchema = z.object({
  billingCycle: z.enum(BILLING_CYCLES).optional(),
  /** Nueva fecha de fin del período (cortesía o activación manual). Reactiva si estaba suspendida. */
  currentPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().min(5).max(300),
});

export const voidSaasInvoiceSchema = z.object({ reason: z.string().min(5).max(300) });
