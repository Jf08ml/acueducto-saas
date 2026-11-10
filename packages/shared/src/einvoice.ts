import { z } from 'zod';

/**
 * BASE de facturación electrónica (DIAN). Deja listo el modelo, la numeración autorizada, el documento neutro
 * y el envío por un proveedor tecnológico. Hoy solo existe un proveedor SIMULADO (sin validez ante la DIAN).
 *
 * ORIENTATIVO (validar con un asesor tributario): los prestadores de servicios públicos domiciliarios pueden
 * expedir el «documento equivalente electrónico de SPD» (Resolución DIAN 000165 de 2023) o factura electrónica
 * de venta, según su calendario y régimen. La mayoría opera a través de un proveedor tecnológico autorizado,
 * que es quien firma, arma el XML UBL y lo transmite a la DIAN.
 */

export const EINVOICE_PROVIDERS = [['simulated', 'Simulado (pruebas, sin validez ante la DIAN)']] as const;
export type EInvoiceProviderKey = (typeof EINVOICE_PROVIDERS)[number][0];

export const EINVOICE_DOCUMENT_TYPES = [
  ['documento_equivalente_spd', 'Documento equivalente electrónico de servicios públicos (SPD)'],
  ['factura_venta', 'Factura electrónica de venta'],
] as const;

export const EINVOICE_STATUS_LABEL: Record<string, string> = {
  pending: 'Por enviar',
  accepted: 'Aceptada',
  rejected: 'Rechazada',
  error: 'Error de envío',
  void: 'Anulada antes de enviar',
  requires_credit_note: 'Requiere nota crédito',
};

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

export const einvoiceConfigSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(['simulated']),
    environment: z.enum(['habilitacion', 'produccion']),
    documentType: z.enum(['documento_equivalente_spd', 'factura_venta']),
    resolution: z.object({
      number: z.string().min(1).max(40),
      date: ymd,
      prefix: z.string().regex(/^[A-Z0-9]{0,4}$/, 'Prefijo: hasta 4 letras o números en mayúscula'),
      rangeFrom: z.number().int().min(1),
      rangeTo: z.number().int().min(1),
      validFrom: ymd,
      validTo: ymd,
    }),
    /** Clave técnica de la resolución. Solo se escribe: la API nunca la devuelve. Vacío = conservar la guardada. */
    technicalKey: z.string().max(200).optional(),
  })
  .refine((c) => c.resolution.rangeTo >= c.resolution.rangeFrom, { message: 'El rango final debe ser mayor o igual al inicial', path: ['resolution', 'rangeTo'] })
  .refine((c) => c.resolution.validTo >= c.resolution.validFrom, { message: 'La vigencia final debe ser posterior a la inicial', path: ['resolution', 'validTo'] })
  .refine((c) => !(c.provider === 'simulated' && c.environment === 'produccion'), {
    message: 'El proveedor simulado solo se puede usar en habilitación (pruebas)', path: ['environment'],
  });
export type EInvoiceConfigInput = z.infer<typeof einvoiceConfigSchema>;

/** Siguiente número dentro del rango autorizado. Lanza si el rango se agotó. */
export function nextEInvoiceNumber(last: number | null, range: { rangeFrom: number; rangeTo: number }): number {
  const next = last === null || last < range.rangeFrom ? range.rangeFrom : last + 1;
  if (next > range.rangeTo) throw new Error('Se agotó el rango de numeración autorizado por la DIAN. Solicita una nueva resolución');
  return next;
}

/** Avisos sobre la resolución: rango por agotarse o vigencia por terminar. */
export function resolutionWarnings(
  r: { rangeFrom: number; rangeTo: number; validTo: string },
  last: number | null,
  today: string,
): string[] {
  const out: string[] = [];
  const used = last === null ? 0 : Math.max(0, last - r.rangeFrom + 1);
  const total = r.rangeTo - r.rangeFrom + 1;
  const left = total - used;
  if (left <= 0) out.push('El rango de numeración está agotado.');
  else if (left / total <= 0.1) out.push(`Quedan ${left} números del rango autorizado.`);
  const days = Math.round((Date.parse(`${r.validTo}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) out.push('La resolución de numeración está vencida.');
  else if (days <= 30) out.push(`La resolución vence en ${days} días.`);
  return out;
}

/** Documento neutro (independiente del proveedor). El proveedor lo convierte a su API o a UBL 2.1. */
export interface EInvoicePayload {
  documentType: string;
  environment: string;
  prefix: string;
  number: number;
  fullNumber: string;
  issueDate: string;
  dueDate: string;
  currency: 'COP';
  issuer: { nit: string; dv: number; legalName: string; name: string; municipality: string; department: string; email: string; phone: string };
  customer: { documentNumber: string; name: string; address: string; email?: string | null };
  lines: { concept: string; description: string; quantity: number; unitPrice: number; amount: number }[];
  totals: { lines: number; subsidies: number; contributions: number; interest: number; total: number };
  /** Datos propios del servicio público domiciliario (período, medidor, consumo, estrato). */
  service: { period: string; subscriberCode: string; usage: string; stratum: number | null; meterSerial: string | null; consumptionM3: number };
  resolution: { number: string; date: string; rangeFrom: number; rangeTo: number; validFrom: string; validTo: string };
}

const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const day = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export function buildEInvoicePayload(input: {
  config: Pick<EInvoiceConfigInput, 'documentType' | 'environment' | 'resolution'>;
  number: number;
  org: { nit: string; nitDv: number; legalName: string; name: string; municipality: string; department: string; contactEmail: string; contactPhone: string };
  invoice: {
    issueDate: Date | string; dueDate: Date | string; period: string; consumptionM3: unknown; total: unknown; subsidyAmount: unknown; contributionAmount: unknown;
    interestAmount: unknown; subscriberSnapshot: any; readingSnapshot: any;
    lines: { concept: string; description: string; quantity: unknown; unitPrice: unknown; amount: unknown }[];
  };
}): EInvoicePayload {
  const { config, number, org, invoice } = input;
  const s = invoice.subscriberSnapshot ?? {};
  const r = invoice.readingSnapshot ?? {};
  const lines = invoice.lines.map((l) => ({ concept: l.concept, description: l.description, quantity: n(l.quantity), unitPrice: n(l.unitPrice), amount: n(l.amount) }));
  return {
    documentType: config.documentType,
    environment: config.environment,
    prefix: config.resolution.prefix,
    number,
    fullNumber: `${config.resolution.prefix}${number}`,
    issueDate: day(invoice.issueDate),
    dueDate: day(invoice.dueDate),
    currency: 'COP',
    issuer: { nit: org.nit, dv: org.nitDv, legalName: org.legalName, name: org.name, municipality: org.municipality, department: org.department, email: org.contactEmail, phone: org.contactPhone },
    customer: { documentNumber: String(s.documentNumber ?? ''), name: String(s.fullName ?? ''), address: String(s.address ?? ''), email: s.email ?? null },
    lines,
    totals: {
      lines: n(lines.reduce((a, l) => a + l.amount, 0)),
      subsidies: n(invoice.subsidyAmount),
      contributions: n(invoice.contributionAmount),
      interest: n(invoice.interestAmount),
      total: n(invoice.total),
    },
    service: {
      period: invoice.period, subscriberCode: String(s.code ?? ''), usage: String(s.usage ?? ''), stratum: s.stratum ?? null,
      meterSerial: r.meterSerial ?? null, consumptionM3: n(invoice.consumptionM3),
    },
    resolution: config.resolution,
  };
}
