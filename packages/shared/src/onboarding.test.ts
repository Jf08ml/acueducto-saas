import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestedBasicConsumptionM3, tariffSchema } from './onboarding';

const base = {
  name: 'Tarifa 2026', effectiveFrom: '2026-01-01', billingPeriod: 'monthly' as const, basicConsumptionM3: 16,
  fixedCharge: 8000, rateBasic: 1200, rateComplementary: 1500, rateSumptuary: 1800,
};

test('consumo básico según altitud', () => {
  assert.equal(suggestedBasicConsumptionM3(2527), 16);
  assert.equal(suggestedBasicConsumptionM3(1500), 13);
  assert.equal(suggestedBasicConsumptionM3(300), 11);
});

test('tarifa con subsidios dentro de los topes es válida', () => {
  assert.equal(tariffSchema.safeParse({ ...base, stratumFactors: { '1': -70, '2': -40, '3': -15, '4': 0, '5': 50 } }).success, true);
});

test('rechaza subsidio por encima del tope o en estratos sin subsidio', () => {
  assert.equal(tariffSchema.safeParse({ ...base, stratumFactors: { '1': -80 } }).success, false);
  assert.equal(tariffSchema.safeParse({ ...base, stratumFactors: { '5': -10 } }).success, false);
  assert.equal(tariffSchema.safeParse({ ...base, stratumFactors: { '4': 10 } }).success, false);
});
