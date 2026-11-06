import { z } from 'zod';
import { periodSchema } from './readings';

export const USAGES = [
  ['residencial', 'Residencial'],
  ['comercial', 'Comercial'],
  ['industrial', 'Industrial'],
  ['oficial', 'Oficial'],
] as const;
export type Usage = (typeof USAGES)[number][0];

export interface TariffForBilling {
  basicConsumptionM3: number;
  sumptuaryFromM3: number | null;
  fixedCharge: number;
  rateBasic: number;
  rateComplementary: number;
  rateSumptuary: number;
  /** % por estrato o uso: negativo = subsidio, positivo = contribución. */
  stratumFactors: Record<string, number>;
}

export interface InvoiceLineCalc {
  concept: 'cargo_fijo' | 'consumo_basico' | 'consumo_complementario' | 'consumo_suntuario' | 'subsidio' | 'contribucion' | 'interes_mora' | 'reconexion' | 'otro_cargo';
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoiceCalc {
  lines: InvoiceLineCalc[];
  factorKey: string;
  factorPct: number;
  subtotal: number;
  subsidy: number; // valor negativo o 0
  contribution: number; // valor positivo o 0
  total: number;
}

/** Pesos colombianos: se redondea al peso entero. */
const peso = (n: number) => Math.round(n);

/** Clave del factor de subsidio/contribución: residencial usa su estrato; los demás usos, su tipo. */
export function factorKeyFor(usage: string, stratum: number | null | undefined): string {
  return usage === 'residencial' ? (stratum ? String(stratum) : '') : usage;
}

/**
 * Calcula la factura de acueducto de un suscriptor en un período.
 *  - Consumo por rangos: básico (hasta el consumo básico), complementario (hasta el umbral suntuario) y suntuario (lo que exceda).
 *    El umbral suntuario es configurable en la tarifa; si no se define, se usa 2 × consumo básico.
 *  - Subsidio (estratos 1 a 3): se aplica sobre el cargo fijo y el consumo básico.
 *  - Contribución (estratos 5 y 6, comercial, industrial): se aplica sobre el valor total del servicio.
 * Los valores se redondean al peso.
 */
export function computeInvoice(tariff: TariffForBilling, input: { consumptionM3: number; usage: string; stratum: number | null | undefined }): InvoiceCalc {
  const c = Math.max(0, input.consumptionM3);
  const basic = tariff.basicConsumptionM3;
  const suntFrom = Math.max(basic, tariff.sumptuaryFromM3 ?? basic * 2);

  const qBasic = Math.min(c, basic);
  const qComp = Math.max(0, Math.min(c, suntFrom) - basic);
  const qSunt = Math.max(0, c - suntFrom);

  const lines: InvoiceLineCalc[] = [
    { concept: 'cargo_fijo', description: 'Cargo fijo', quantity: 1, unitPrice: tariff.fixedCharge, amount: peso(tariff.fixedCharge) },
  ];
  const push = (concept: InvoiceLineCalc['concept'], description: string, q: number, price: number) => {
    if (q > 0) lines.push({ concept, description, quantity: Math.round(q * 100) / 100, unitPrice: price, amount: peso(q * price) });
  };
  push('consumo_basico', `Consumo básico (hasta ${basic} m³)`, qBasic, tariff.rateBasic);
  push('consumo_complementario', `Consumo complementario (${basic}–${suntFrom} m³)`, qComp, tariff.rateComplementary);
  push('consumo_suntuario', `Consumo suntuario (más de ${suntFrom} m³)`, qSunt, tariff.rateSumptuary);

  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const factorKey = factorKeyFor(input.usage, input.stratum);
  const factorPct = tariff.stratumFactors[factorKey] ?? 0;

  let subsidy = 0;
  let contribution = 0;
  if (factorPct < 0) {
    const base = lines.filter((l) => l.concept === 'cargo_fijo' || l.concept === 'consumo_basico').reduce((a, l) => a + l.amount, 0);
    subsidy = peso((base * factorPct) / 100);
    lines.push({ concept: 'subsidio', description: `Subsidio ${Math.abs(factorPct)}% (cargo fijo y consumo básico)`, quantity: 1, unitPrice: subsidy, amount: subsidy });
  } else if (factorPct > 0) {
    contribution = peso((subtotal * factorPct) / 100);
    lines.push({ concept: 'contribucion', description: `Contribución ${factorPct}%`, quantity: 1, unitPrice: contribution, amount: contribution });
  }

  return { lines, factorKey, factorPct, subtotal, subsidy, contribution, total: subtotal + subsidy + contribution };
}

export const billingOptionsSchema = z.object({
  /** Qué hacer con medidores activos sin lectura del período. */
  missingReadings: z.enum(['block', 'fixed_only']).default('block'),
  /** m³ que se facturan a suscriptores sin medidor (aforo). null = solo cargo fijo. */
  unmeteredConsumptionM3: z.number().min(0).max(1000).nullable().default(null),
});
export type BillingOptions = z.infer<typeof billingOptionsSchema>;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const previewBillingSchema = z.object({ period: periodSchema, options: billingOptionsSchema, issueDate: date.optional() });
export const issueBillingSchema = z
  .object({ period: periodSchema, options: billingOptionsSchema, issueDate: date, dueDate: date })
  .refine((v) => v.dueDate >= v.issueDate, { message: 'La fecha límite de pago no puede ser anterior a la de expedición', path: ['dueDate'] });
export type IssueBillingInput = z.infer<typeof issueBillingSchema>;

export const voidBillingSchema = z.object({ reason: z.string().min(5).max(300) });

export const CONCEPT_LABEL: Record<string, string> = {
  cargo_fijo: 'Cargo fijo',
  consumo_basico: 'Consumo básico',
  consumo_complementario: 'Consumo complementario',
  consumo_suntuario: 'Consumo suntuario',
  subsidio: 'Subsidio',
  contribucion: 'Contribución',
  interes_mora: 'Intereses de mora',
  reconexion: 'Reconexión',
  otro_cargo: 'Otros cargos',
};
