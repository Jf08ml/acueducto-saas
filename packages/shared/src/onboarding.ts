import { z } from 'zod';

export const LEGAL_NATURES = [
  ['sin_animo_lucro', 'Entidad sin ánimo de lucro (asociación, cooperativa, JAC)'],
  ['sociedad_por_acciones', 'Sociedad por acciones (E.S.P. privada)'],
  ['publica', 'Entidad pública'],
  ['mixta', 'Sociedad de economía mixta'],
] as const;

/** Tipos de prestador según el art. 15 de la Ley 142 de 1994. */
export const PROVIDER_TYPES = [
  ['organizacion_autorizada', 'Organización autorizada (comunitaria, municipios menores o zonas rurales)'],
  ['esp', 'Empresa de servicios públicos (E.S.P.)'],
  ['municipio_directo', 'Municipio como prestador directo'],
  ['productor_marginal', 'Productor marginal o para uso particular'],
] as const;

export const AREA_TYPES = [
  ['rural', 'Rural'],
  ['urbana', 'Urbana'],
  ['mixta', 'Urbana y rural'],
] as const;

const values = <T extends readonly (readonly [string, string])[]>(list: T) =>
  list.map(([v]) => v) as unknown as [T[number][0], ...T[number][0][]];

export const orgProfileSchema = z.object({
  legalNature: z.enum(values(LEGAL_NATURES)),
  providerType: z.enum(values(PROVIDER_TYPES)),
  areaType: z.enum(values(AREA_TYPES)),
  altitudeMasl: z.number().int().min(0).max(5000),
  estimatedSubscribers: z.number().int().min(0),
});
export type OrgProfileInput = z.infer<typeof orgProfileSchema>;

/**
 * Consumo básico sugerido según la altitud promedio (Resolución CRA 750 de 2016).
 * Es una sugerencia editable; el acueducto confirma el valor que aplica.
 */
export function suggestedBasicConsumptionM3(altitudeMasl: number): number {
  if (altitudeMasl > 2000) return 16;
  if (altitudeMasl >= 1000) return 13;
  return 11;
}

/** Topes máximos de subsidio por estrato (Ley 1450 de 2011 art. 125, prorrogado por leyes posteriores). */
export const MAX_SUBSIDY_PCT: Record<string, number> = { '1': 70, '2': 40, '3': 15 };

const money = z.number().min(0).max(100_000_000);
const factorKeys = ['1', '2', '3', '4', '5', '6', 'comercial', 'industrial', 'oficial'] as const;

export const tariffSchema = z
  .object({
    name: z.string().min(3),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    billingPeriod: z.enum(['monthly', 'bimonthly']),
    basicConsumptionM3: z.number().int().min(1).max(100),
    fixedCharge: money,
    rateBasic: money,
    rateComplementary: money,
    rateSumptuary: money,
    /** % por estrato o uso: negativo = subsidio, positivo = contribución. */
    stratumFactors: z.record(z.enum(factorKeys), z.number().min(-100).max(200)),
  })
  .superRefine((t, ctx) => {
    for (const [k, v] of Object.entries(t.stratumFactors)) {
      const cap = MAX_SUBSIDY_PCT[k];
      if (v < 0 && cap === undefined) {
        ctx.addIssue({ code: 'custom', path: ['stratumFactors', k], message: `El estrato/uso ${k} no puede recibir subsidio` });
      } else if (v < 0 && -v > cap) {
        ctx.addIssue({ code: 'custom', path: ['stratumFactors', k], message: `El subsidio del estrato ${k} no puede superar ${cap}%` });
      }
      if (k === '4' && v !== 0) {
        ctx.addIssue({ code: 'custom', path: ['stratumFactors', k], message: 'El estrato 4 paga el costo de referencia (factor 0)' });
      }
    }
  });
export type TariffInput = z.infer<typeof tariffSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color en formato #RRGGBB');
export const brandingSchema = z.object({
  primaryColor: hexColor,
  secondaryColor: hexColor,
  receiptFooter: z.string().max(300).optional(),
});
export type BrandingInput = z.infer<typeof brandingSchema>;

export const COMPLIANCE_STATUSES = ['pending', 'in_progress', 'done', 'not_applicable'] as const;
export const complianceUpdateSchema = z.object({
  status: z.enum(COMPLIANCE_STATUSES),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

/** Columnas de la plantilla de importación de suscriptores (fila 1 = encabezados). */
export const SUBSCRIBER_IMPORT_COLUMNS = [
  { key: 'code', header: 'codigo', required: true },
  { key: 'fullName', header: 'nombre_completo', required: true },
  { key: 'documentNumber', header: 'documento', required: true },
  { key: 'address', header: 'direccion', required: true },
  { key: 'stratum', header: 'estrato', required: false },
] as const;
