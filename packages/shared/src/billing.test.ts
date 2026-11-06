import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInvoice, type TariffForBilling } from './billing';

const tariff: TariffForBilling = {
  basicConsumptionM3: 16, sumptuaryFromM3: null, fixedCharge: 8500,
  rateBasic: 1250, rateComplementary: 1600, rateSumptuary: 1900,
  stratumFactors: { '1': -50, '2': -40, '3': -15, '4': 0, '5': 50, comercial: 50 },
};

test('estrato 4: sin subsidio ni contribución, solo consumo básico', () => {
  const r = computeInvoice(tariff, { consumptionM3: 10, usage: 'residencial', stratum: 4 });
  assert.equal(r.subtotal, 8500 + 12500);
  assert.equal(r.total, 21000);
  assert.deepEqual(r.lines.map((l) => l.concept), ['cargo_fijo', 'consumo_basico']);
});

test('rangos: básico 16, complementario hasta 32, suntuario por encima', () => {
  const r = computeInvoice(tariff, { consumptionM3: 40, usage: 'residencial', stratum: 4 });
  const by = Object.fromEntries(r.lines.map((l) => [l.concept, l]));
  assert.equal(by.consumo_basico.quantity, 16);
  assert.equal(by.consumo_complementario.quantity, 16);
  assert.equal(by.consumo_suntuario.quantity, 8);
  assert.equal(r.total, 8500 + 16 * 1250 + 16 * 1600 + 8 * 1900);
});

test('estrato 1: subsidio del 50% solo sobre cargo fijo y consumo básico', () => {
  const r = computeInvoice(tariff, { consumptionM3: 20, usage: 'residencial', stratum: 1 });
  // base subsidiable = 8500 + 16*1250 = 28500 -> subsidio 14250; complementario 4*1600 = 6400 sin subsidio
  assert.equal(r.subsidy, -14250);
  assert.equal(r.total, 8500 + 20000 + 6400 - 14250);
});

test('comercial: contribución del 50% sobre todo el servicio', () => {
  const r = computeInvoice(tariff, { consumptionM3: 10, usage: 'comercial', stratum: 3 });
  assert.equal(r.factorKey, 'comercial');
  assert.equal(r.contribution, 10500);
  assert.equal(r.total, 31500);
});

test('consumo 0 o sin estrato: solo cargo fijo, sin factor', () => {
  const r = computeInvoice(tariff, { consumptionM3: 0, usage: 'residencial', stratum: null });
  assert.equal(r.total, 8500);
  assert.equal(r.factorPct, 0);
});
