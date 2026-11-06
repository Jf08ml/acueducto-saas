import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Configuración de cobro del acueducto. Las tasas son % MENSUAL de interés simple.
 * Orientativo: para usuarios residenciales suele aplicarse la tasa de interés civil y para los
 * no residenciales la comercial, sin superar la tasa de usura certificada. Verifícalo con tu asesor.
 */
export const collectionSettingsSchema = z.object({
  lateInterestEnabled: z.boolean(),
  residentialMonthlyRatePct: z.number().min(0).max(5),
  nonResidentialMonthlyRatePct: z.number().min(0).max(5),
  /** Días después del vencimiento antes de empezar a causar intereses. */
  graceDays: z.number().int().min(0).max(60),
  reconnectionFee: z.number().min(0).max(10_000_000),
  /** Facturas vencidas a partir de las cuales el suscriptor aparece en la lista de suspensión. */
  suspensionMinOverdue: z.number().int().min(1).max(3),
});
export type CollectionSettings = z.infer<typeof collectionSettingsSchema>;

export const DEFAULT_COLLECTION_SETTINGS: CollectionSettings = {
  lateInterestEnabled: false,
  residentialMonthlyRatePct: 0.5,
  nonResidentialMonthlyRatePct: 1.5,
  graceDays: 0,
  reconnectionFee: 0,
  suspensionMinOverdue: 2,
};

export function withCollectionDefaults(raw: unknown): CollectionSettings {
  const parsed = collectionSettingsSchema.partial().safeParse(raw ?? {});
  return { ...DEFAULT_COLLECTION_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}

const dayMs = 86_400_000;
const toDay = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const fromDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface OverdueBase {
  invoiceNumber: number;
  dueDate: string;
  /** Saldo de capital: lo pendiente SIN los intereses ya facturados (no se cobran intereses sobre intereses). */
  base: number;
}

/**
 * Intereses de mora simples a la fecha `asOf`, prorrateados por días (mes de 30 días).
 * Cada factura causa desde max(vencimiento + gracia, `floorDate`), donde `floorDate` es la fecha de la última
 * factura en la que ya se cobraron intereses a este suscriptor; así nunca se cobra dos veces el mismo tramo.
 */
export function computeLateInterest(overdue: OverdueBase[], asOf: string, monthlyRatePct: number, graceDays: number, floorDate: string | null) {
  const end = toDay(asOf);
  const floor = floorDate ? toDay(floorDate) : -Infinity;
  const details: { invoiceNumber: number; base: number; from: string; days: number; amount: number }[] = [];
  for (const o of overdue) {
    if (o.base <= 0) continue;
    const start = Math.max(toDay(o.dueDate) + graceDays * dayMs, floor);
    const days = Math.floor((end - start) / dayMs);
    if (days <= 0) continue;
    const amount = Math.round(o.base * (monthlyRatePct / 100) * (days / 30));
    if (amount > 0) details.push({ invoiceNumber: o.invoiceNumber, base: o.base, from: fromDay(start), days, amount });
  }
  return { amount: details.reduce((a, d) => a + d.amount, 0), details };
}

export const createChargeSchema = z.object({
  subscriberId: z.string().uuid(),
  description: z.string().min(3).max(120),
  amount: z.number().positive().max(10_000_000),
});

export const suspendSchema = z.object({
  date,
  reason: z.string().min(5).max(300),
  notes: z.string().max(500).optional(),
});

export const reconnectSchema = z
  .object({
    date,
    notes: z.string().max(500).optional(),
    /** null = usar el cargo configurado; 0 = sin cargo. */
    reconnectionFee: z.number().min(0).max(10_000_000).nullable(),
    /** Reconectar aunque tenga deuda (p. ej. acuerdo de pago). Exige explicar el motivo en `notes`. */
    allowWithDebt: z.boolean().default(false),
  })
  .refine((v) => !v.allowWithDebt || (v.notes?.trim().length ?? 0) >= 5, {
    message: 'Explica por qué se reconecta con deuda (p. ej. acuerdo de pago)',
    path: ['notes'],
  });
export type ReconnectInput = z.infer<typeof reconnectSchema>;
