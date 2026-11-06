import { z } from 'zod';

export const PAYMENT_METHODS = [
  ['efectivo', 'Efectivo'],
  ['transferencia', 'Transferencia'],
  ['consignacion', 'Consignación'],
  ['pse', 'PSE'],
  ['otro', 'Otro'],
] as const;
type Method = (typeof PAYMENT_METHODS)[number][0];
const methods = PAYMENT_METHODS.map(([v]) => v) as [Method, ...Method[]];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createPaymentSchema = z.object({
  subscriberId: z.string().uuid(),
  amount: z.number().positive().max(1_000_000_000),
  paidAt: date,
  method: z.enum(methods),
  reference: z.string().max(80).optional(),
  notes: z.string().max(300).optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const voidPaymentSchema = z.object({ reason: z.string().min(5).max(300) });

export interface OpenInvoice {
  id: string;
  outstanding: number;
}

/**
 * Reparte un pago entre las facturas pendientes, de la más antigua a la más reciente.
 * Devuelve cuánto se aplica a cada una y lo que sobra (si el pago supera la deuda).
 */
export function allocateFifo(invoicesOldestFirst: OpenInvoice[], amount: number) {
  let left = Math.round(amount * 100) / 100;
  const allocations: { invoiceId: string; amount: number }[] = [];
  for (const inv of invoicesOldestFirst) {
    if (left <= 0) break;
    const take = Math.min(left, Math.round(inv.outstanding * 100) / 100);
    if (take > 0) {
      allocations.push({ invoiceId: inv.id, amount: take });
      left = Math.round((left - take) * 100) / 100;
    }
  }
  return { allocations, remainder: left };
}

export const AGING_BUCKETS = [
  ['current', 'Corriente'],
  ['d1_30', '1–30 días'],
  ['d31_60', '31–60 días'],
  ['d61_90', '61–90 días'],
  ['d90p', 'Más de 90 días'],
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number][0];

/** Días de mora de una factura a la fecha de corte (0 si aún no vence). Fechas AAAA-MM-DD. */
export function daysPastDue(dueDate: string, asOf: string): number {
  const ms = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  const d = daysPastDue(dueDate, asOf);
  if (d === 0) return 'current';
  if (d <= 30) return 'd1_30';
  if (d <= 60) return 'd31_60';
  if (d <= 90) return 'd61_90';
  return 'd90p';
}

/**
 * La Ley 142 de 1994 (art. 140, modificado por la Ley 689 de 2001) permite suspender por falta de pago
 * sin exceder 3 períodos si la facturación es mensual o 2 si es bimestral. El acueducto define su umbral.
 */
export const MAX_OVERDUE_BEFORE_SUSPENSION = { monthly: 3, bimonthly: 2 } as const;

/** Referencia de pago impresa en el recibo: "<código del suscriptor>-<número de factura>". */
export function paymentReference(subscriberCode: string, invoiceNumber: number) {
  return `${subscriberCode}-${invoiceNumber}`;
}

/** El código puede contener guiones: el número de factura es lo que va después del último. */
export function parsePaymentReference(ref: string): { code: string; number: number } | null {
  const m = /^(.+)-(\d+)$/.exec(ref.trim());
  return m ? { code: m[1], number: Number(m[2]) } : null;
}
