import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLateInterest, withCollectionDefaults } from './collections';

test('interés simple prorrateado por días desde el vencimiento', () => {
  // 21.000 al 1,5% mensual durante 30 días = 315
  const r = computeLateInterest([{ invoiceNumber: 1, dueDate: '2026-02-15', base: 21000 }], '2026-03-17', 1.5, 0, null);
  assert.equal(r.amount, 315);
  assert.equal(r.details[0].days, 30);
});

test('no cobra dos veces el mismo tramo: parte de la última fecha en que se cobró', () => {
  const r = computeLateInterest([{ invoiceNumber: 1, dueDate: '2026-02-15', base: 21000 }], '2026-04-16', 1.5, 0, '2026-03-17');
  assert.equal(r.details[0].from, '2026-03-17');
  assert.equal(r.details[0].days, 30);
  assert.equal(r.amount, 315);
});

test('respeta los días de gracia y no cobra si aún no vence', () => {
  assert.equal(computeLateInterest([{ invoiceNumber: 1, dueDate: '2026-02-15', base: 21000 }], '2026-02-20', 1.5, 10, null).amount, 0);
  assert.equal(computeLateInterest([{ invoiceNumber: 1, dueDate: '2026-03-15', base: 21000 }], '2026-03-01', 1.5, 0, null).amount, 0);
  assert.equal(computeLateInterest([{ invoiceNumber: 1, dueDate: '2026-02-15', base: 0 }], '2026-06-01', 1.5, 0, null).amount, 0);
});

test('la configuración incompleta o inválida usa valores por defecto', () => {
  assert.equal(withCollectionDefaults({ reconnectionFee: 25000 }).reconnectionFee, 25000);
  assert.equal(withCollectionDefaults({ residentialMonthlyRatePct: 99 }).residentialMonthlyRatePct, 0.5);
  assert.equal(withCollectionDefaults(null).lateInterestEnabled, false);
});
