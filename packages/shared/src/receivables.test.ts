import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agingBucket, allocateFifo, daysPastDue, parsePaymentReference } from './receivables';

test('el pago se aplica primero a la factura más antigua', () => {
  const r = allocateFifo([{ id: 'ene', outstanding: 20000 }, { id: 'feb', outstanding: 25000 }], 30000);
  assert.deepEqual(r.allocations, [{ invoiceId: 'ene', amount: 20000 }, { invoiceId: 'feb', amount: 10000 }]);
  assert.equal(r.remainder, 0);
});

test('si el pago supera la deuda, queda remanente', () => {
  const r = allocateFifo([{ id: 'ene', outstanding: 20000 }], 25000.5);
  assert.deepEqual(r.allocations, [{ invoiceId: 'ene', amount: 20000 }]);
  assert.equal(r.remainder, 5000.5);
});

test('edades de cartera', () => {
  assert.equal(daysPastDue('2026-02-15', '2026-02-15'), 0);
  assert.equal(agingBucket('2026-02-15', '2026-02-10'), 'current');
  assert.equal(agingBucket('2026-02-15', '2026-02-16'), 'd1_30');
  assert.equal(agingBucket('2026-02-15', '2026-04-01'), 'd31_60');
  assert.equal(agingBucket('2026-02-15', '2026-05-01'), 'd61_90');
  assert.equal(agingBucket('2026-02-15', '2026-07-01'), 'd90p');
});

test('referencia de pago con guiones en el código', () => {
  assert.deepEqual(parsePaymentReference('V-12-001-45'), { code: 'V-12-001', number: 45 });
  assert.equal(parsePaymentReference('sin-numero-x'), null);
});
