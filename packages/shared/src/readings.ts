import { z } from 'zod';

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const periodSchema = z.string().regex(PERIOD_RE, 'Período en formato AAAA-MM');

export function currentPeriod(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Causales de no lectura u observaciones de campo. */
export const READING_OBSERVATIONS = [
  ['predio_cerrado', 'Predio cerrado'],
  ['medidor_danado', 'Medidor dañado'],
  ['medidor_ilegible', 'Medidor ilegible'],
  ['acceso_impedido', 'Acceso impedido'],
  ['medidor_invertido', 'Medidor invertido o manipulado'],
  ['fuga_visible', 'Fuga visible'],
  ['sin_medidor', 'Sin medidor'],
] as const;
export type ReadingObservation = (typeof READING_OBSERVATIONS)[number][0];

const observationValues = READING_OBSERVATIONS.map(([v]) => v) as [ReadingObservation, ...ReadingObservation[]];

export const createMeterSchema = z.object({
  subscriberId: z.string().uuid(),
  serial: z.string().min(2).max(40),
  brand: z.string().max(60).optional(),
  diameter: z.string().max(10).optional(),
  installedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  initialReading: z.number().min(0).max(9_999_999),
  notes: z.string().max(500).optional(),
});
export type CreateMeterInput = z.infer<typeof createMeterSchema>;

export const meterStatusSchema = z.object({
  status: z.enum(['removed', 'damaged', 'active']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(500).optional(),
});

/** Una lectura: o trae el valor del medidor, o trae una causal de no lectura (se estima el consumo). */
export const readingEntrySchema = z
  .object({
    meterId: z.string().uuid(),
    value: z.number().min(0).max(9_999_999).nullable(),
    observation: z.enum(observationValues).nullable().optional(),
  })
  .refine((r) => r.value !== null || !!r.observation, { message: 'Sin lectura debes indicar la causal', path: ['observation'] });

export const saveReadingsSchema = z.object({
  period: periodSchema,
  readingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entries: z.array(readingEntrySchema).min(1).max(2000),
});
export type SaveReadingsInput = z.infer<typeof saveReadingsSchema>;

/** Desviación significativa: consumo mayor a este múltiplo del promedio (Ley 142 de 1994, art. 149). */
export const HIGH_CONSUMPTION_FACTOR = 2;

export interface ConsumptionResult {
  consumption: number;
  isEstimated: boolean;
  anomaly: 'negative' | 'high' | 'zero' | 'estimated' | null;
}

/**
 * Calcula el consumo del período. Si no hay lectura se estima con el promedio de los últimos períodos
 * (Ley 142 de 1994, art. 146). Las lecturas negativas se marcan para revisión y no se facturan como negativas.
 */
export function computeConsumption(previous: number, value: number | null, history: number[]): ConsumptionResult {
  const recent = history.slice(0, 6);
  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  if (value === null) {
    return { consumption: Math.round(avg * 100) / 100, isEstimated: true, anomaly: 'estimated' };
  }
  const raw = Math.round((value - previous) * 100) / 100;
  if (raw < 0) return { consumption: 0, isEstimated: false, anomaly: 'negative' };
  if (raw === 0) return { consumption: 0, isEstimated: false, anomaly: 'zero' };
  if (recent.length >= 3 && avg > 0 && raw > avg * HIGH_CONSUMPTION_FACTOR) {
    return { consumption: raw, isEstimated: false, anomaly: 'high' };
  }
  return { consumption: raw, isEstimated: false, anomaly: null };
}
