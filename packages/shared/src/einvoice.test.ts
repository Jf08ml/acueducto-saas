import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEInvoicePayload, einvoiceConfigSchema, nextEInvoiceNumber, resolutionWarnings } from './einvoice';

const resolution = { number: '18760000001', date: '2026-01-15', prefix: 'SPD', rangeFrom: 1, rangeTo: 100, validFrom: '2026-01-15', validTo: '2027-01-15' };

describe('numeración autorizada', () => {
  it('empieza en el inicio del rango y sigue en orden', () => {
    assert.equal(nextEInvoiceNumber(null, resolution), 1);
    assert.equal(nextEInvoiceNumber(41, resolution), 42);
    assert.equal(nextEInvoiceNumber(0, { rangeFrom: 500, rangeTo: 900 }), 500);
  });
  it('no se pasa del rango', () => {
    assert.equal(nextEInvoiceNumber(99, resolution), 100);
    assert.throws(() => nextEInvoiceNumber(100, resolution), /agotó/);
  });
  it('avisa cuando el rango o la vigencia están por terminar', () => {
    assert.deepEqual(resolutionWarnings(resolution, 10, '2026-06-01'), []);
    assert.match(resolutionWarnings(resolution, 95, '2026-06-01')[0], /Quedan 5/);
    assert.match(resolutionWarnings(resolution, 10, '2027-01-01')[0], /vence en 14 días/);
    assert.match(resolutionWarnings(resolution, 10, '2027-02-01')[0], /vencida/);
    assert.match(resolutionWarnings(resolution, 100, '2026-06-01')[0], /agotado/);
  });
});

describe('configuración', () => {
  const base = { enabled: true, provider: 'simulated' as const, environment: 'habilitacion' as const, documentType: 'documento_equivalente_spd' as const, resolution };
  it('acepta una configuración válida', () => {
    assert.equal(einvoiceConfigSchema.safeParse(base).success, true);
  });
  it('el simulado no se puede usar en producción', () => {
    assert.equal(einvoiceConfigSchema.safeParse({ ...base, environment: 'produccion' }).success, false);
  });
  it('rango y vigencia deben ser coherentes', () => {
    assert.equal(einvoiceConfigSchema.safeParse({ ...base, resolution: { ...resolution, rangeTo: 0 } }).success, false);
    assert.equal(einvoiceConfigSchema.safeParse({ ...base, resolution: { ...resolution, validTo: '2025-01-01' } }).success, false);
    assert.equal(einvoiceConfigSchema.safeParse({ ...base, resolution: { ...resolution, prefix: 'spd' } }).success, false);
  });
});

describe('documento neutro', () => {
  const payload = buildEInvoicePayload({
    config: { documentType: 'documento_equivalente_spd', environment: 'habilitacion', resolution },
    number: 7,
    org: { nit: '900123456', nitDv: 7, legalName: 'Asociación Agua Mata', name: 'Agua Mata', municipality: 'Pasto', department: 'Nariño', contactEmail: 'a@b.co', contactPhone: '300' },
    invoice: {
      issueDate: new Date('2026-11-01T00:00:00Z'), dueDate: '2026-11-15', period: '2026-10', consumptionM3: '21.00', total: '33460.00', subsidyAmount: '15640',
      contributionAmount: 0, interestAmount: 0,
      subscriberSnapshot: { code: '045', fullName: 'María Pérez', documentNumber: '1085', address: 'Vereda', usage: 'residencial', stratum: 2 },
      readingSnapshot: { meterSerial: 'MED-1' },
      lines: [
        { concept: 'cargo_fijo', description: 'Cargo fijo', quantity: '1', unitPrice: '9500', amount: '9500' },
        { concept: 'consumo_basico', description: 'Consumo básico', quantity: '16', unitPrice: '1850', amount: '29600' },
        { concept: 'subsidio', description: 'Subsidio', quantity: '1', unitPrice: '-15640', amount: '-15640' },
      ],
    },
  });
  it('arma número completo, fechas, totales y datos del servicio', () => {
    assert.equal(payload.fullNumber, 'SPD7');
    assert.equal(payload.issueDate, '2026-11-01');
    assert.equal(payload.totals.lines, 23460);
    assert.equal(payload.totals.total, 33460);
    assert.deepEqual(payload.service, { period: '2026-10', subscriberCode: '045', usage: 'residencial', stratum: 2, meterSerial: 'MED-1', consumptionM3: 21 });
  });
});
