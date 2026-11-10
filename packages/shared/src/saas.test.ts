import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addCycle, subscriptionActions } from './saas';

const d = (s: string) => new Date(`${s}T12:00:00Z`);
const cfg = { leadDays: 7, graceDays: 7 };

describe('addCycle', () => {
  it('suma meses respetando el fin de mes', () => {
    assert.equal(addCycle(d('2026-01-31'), 'monthly').toISOString().slice(0, 10), '2026-02-28');
    assert.equal(addCycle(d('2028-01-31'), 'monthly').toISOString().slice(0, 10), '2028-02-29');
    assert.equal(addCycle(d('2026-03-15'), 'monthly', 2).toISOString().slice(0, 10), '2026-05-15');
    assert.equal(addCycle(d('2026-12-10'), 'monthly').toISOString().slice(0, 10), '2027-01-10');
  });
  it('anual suma 12 meses', () => {
    assert.equal(addCycle(d('2026-11-10'), 'yearly').toISOString().slice(0, 10), '2027-11-10');
    assert.equal(addCycle(d('2028-02-29'), 'yearly').toISOString().slice(0, 10), '2029-02-28');
  });
});

describe('subscriptionActions', () => {
  const base = { status: 'active', currentPeriodEnd: d('2026-12-01'), graceEndsAt: null, hasOpenInvoice: false };

  it('nada que hacer lejos del vencimiento', () => {
    assert.deepEqual(subscriptionActions(base, d('2026-11-10'), cfg), { invoice: false, pastDue: null, suspend: false });
  });
  it('emite la factura siguiente cuando faltan leadDays o menos', () => {
    assert.equal(subscriptionActions(base, d('2026-11-24'), cfg).invoice, true);
    assert.equal(subscriptionActions({ ...base, hasOpenInvoice: true }, d('2026-11-24'), cfg).invoice, false);
  });
  it('al vencer sin pago entra en gracia', () => {
    const r = subscriptionActions({ ...base, hasOpenInvoice: true }, d('2026-12-02'), cfg);
    assert.equal(r.pastDue?.toISOString().slice(0, 10), '2026-12-08');
    assert.equal(r.suspend, false);
  });
  it('se suspende al acabar la gracia', () => {
    const s = { ...base, status: 'past_due', graceEndsAt: d('2026-12-08'), hasOpenInvoice: true };
    assert.equal(subscriptionActions(s, d('2026-12-07'), cfg).suspend, false);
    assert.equal(subscriptionActions(s, d('2026-12-09'), cfg).suspend, true);
  });
  it('una prueba vencida pasa directo a gracia y luego a suspensión', () => {
    const trial = { ...base, status: 'trialing', hasOpenInvoice: true };
    assert.notEqual(subscriptionActions(trial, d('2026-12-02'), cfg).pastDue, null);
    assert.equal(subscriptionActions(trial, d('2026-12-20'), cfg).suspend, true);
  });
  it('sin días de gracia se suspende al vencer', () => {
    assert.equal(subscriptionActions({ ...base, hasOpenInvoice: true }, d('2026-12-02'), { leadDays: 7, graceDays: 0 }).suspend, true);
  });
  it('una suscripción cancelada no hace nada', () => {
    assert.deepEqual(subscriptionActions({ ...base, status: 'cancelled' }, d('2027-01-01'), cfg), { invoice: false, pastDue: null, suspend: false });
  });
});
