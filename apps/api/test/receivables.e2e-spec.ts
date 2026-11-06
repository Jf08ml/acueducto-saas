/**
 * Recaudo (pagos aplicados a la factura más antigua) y cartera por edades.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';

const run = (Date.now() + 4).toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const appRole = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

const TARIFF = {
  name: 'Tarifa', effectiveFrom: '2026-01-01', billingPeriod: 'monthly', basicConsumptionM3: 16,
  fixedCharge: 8500, rateBasic: 1250, rateComplementary: 1600, rateSumptuary: 1900, stratumFactors: { '4': 0 },
};
const OPTS = { missingReadings: 'block', unmeteredConsumptionM3: null };

describe('Recaudo y cartera', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const A = { id: '', token: '', s1: '', s2: '', m1: '', m2: '', jan1: 0, feb1: 0, pay1: '' };
  const B = { id: '', token: '', s1: '', m1: '', invoiceId: '' };

  async function register(tag: string, suffix: string) {
    const nit = `5${run}${suffix}`;
    const email = `rec-${tag}-${run}@test.co`;
    const reg = await http.post('/api/v1/onboarding/organizations').send({
      name: `Acueducto Rec ${tag} ${run}`, legalName: `Asociación Rec ${tag}`, nit, nitDv: nitCheckDigit(nit),
      department: 'Tolima', municipality: 'Ibagué', organizationType: 'comunitario', estimatedSubscribers: 10,
      contactEmail: email, contactPhone: '3001234567', owner: { fullName: `Dueño ${tag}`, email, password: 'Clave12345!' },
    }).expect(201);
    const token = (await http.post('/api/v1/auth/login').send({ email, password: 'Clave12345!' }).expect(201)).body.accessToken;
    await http.put('/api/v1/setup/tariff').set({ Authorization: `Bearer ${token}` }).send(TARIFF).expect(200);
    return { id: reg.body.organizationId as string, token: token as string };
  }
  const sub = async (t: string, code: string) =>
    (await http.post('/api/v1/subscribers').set(auth(t)).send({ code, fullName: `Usuario ${code}`, documentNumber: `9${code}`, address: 'Vereda', stratum: 4 }).expect(201)).body.id;
  const meter = async (t: string, s: string, serial: string) =>
    (await http.post('/api/v1/meters').set(auth(t)).send({ subscriberId: s, serial, installedAt: '2025-12-01', initialReading: 0 }).expect(201)).body.id;
  const read = (t: string, period: string, entries: { meterId: string; value: number }[]) =>
    http.post('/api/v1/readings').set(auth(t)).send({ period, readingDate: `${period}-28`, entries }).expect(201);
  const issue = (t: string, period: string, dueDate: string) =>
    http.post('/api/v1/billing/issue').set(auth(t)).send({ period, options: OPTS, issueDate: `${period}-28`, dueDate }).expect(201);
  const pay = (t: string, subscriberId: string, amount: number, paidAt = '2026-03-01') =>
    http.post('/api/v1/payments').set(auth(t)).send({ subscriberId, amount, paidAt, method: 'efectivo' });
  const invoiceOf = (orgId: string, subscriberId: string, period: string) =>
    owner.invoice.findFirstOrThrow({ where: { organizationId: orgId, subscriberId, period, status: { not: 'void' } } });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    Object.assign(A, await register('A', '1'));
    Object.assign(B, await register('B', '2'));

    A.s1 = await sub(A.token, '001');
    A.s2 = await sub(A.token, '002');
    A.m1 = await meter(A.token, A.s1, `RA1-${run}`);
    A.m2 = await meter(A.token, A.s2, `RA2-${run}`);
    // Enero y febrero: 10 m³ cada mes por suscriptor → 8.500 + 10 × 1.250 = 21.000 por factura.
    await read(A.token, '2026-01', [{ meterId: A.m1, value: 10 }, { meterId: A.m2, value: 10 }]);
    await issue(A.token, '2026-01', '2026-02-15');
    await read(A.token, '2026-02', [{ meterId: A.m1, value: 20 }, { meterId: A.m2, value: 20 }]);
    await issue(A.token, '2026-02', '2026-03-15');

    B.s1 = await sub(B.token, '001');
    B.m1 = await meter(B.token, B.s1, `RB1-${run}`);
    await read(B.token, '2026-01', [{ meterId: B.m1, value: 5 }]);
    await issue(B.token, '2026-01', '2026-02-15');
    B.invoiceId = (await invoiceOf(B.id, B.s1, '2026-01')).id;
  });

  afterAll(async () => {
    const ids = [A.id, B.id].filter(Boolean);
    const where = { organizationId: { in: ids } };
    await owner.paymentAllocation.deleteMany({ where });
    await owner.payment.deleteMany({ where });
    await owner.invoiceLine.deleteMany({ where });
    await owner.invoice.deleteMany({ where });
    await owner.billingPeriod.deleteMany({ where });
    await owner.meterReading.deleteMany({ where });
    await owner.meter.deleteMany({ where });
    await owner.tariffSchedule.deleteMany({ where });
    await owner.subscriber.deleteMany({ where });
    const users = await owner.membership.findMany({ where, select: { userId: true } });
    await owner.organization.deleteMany({ where: { id: { in: ids } } });
    await owner.user.deleteMany({ where: { id: { in: users.map((u) => u.userId) } } });
    await Promise.all([owner.$disconnect(), appRole.$disconnect(), app?.close()]);
  });

  it('la factura de febrero informa el saldo anterior de enero', async () => {
    const feb = await invoiceOf(A.id, A.s1, '2026-02');
    expect(Number(feb.total)).toBe(21000);
    expect(Number(feb.previousBalance)).toBe(21000);
    A.feb1 = feb.number;
    A.jan1 = (await invoiceOf(A.id, A.s1, '2026-01')).number;
  });

  it('se encuentra al suscriptor por la referencia de pago del recibo', async () => {
    const res = await http.get(`/api/v1/payments/lookup?q=001-${A.feb1}`).set(auth(A.token)).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ subscriber: { id: A.s1 }, balance: 42000, overdueInvoices: expect.any(Number) });
  });

  it('el pago se aplica primero a la factura más antigua', async () => {
    const res = await pay(A.token, A.s1, 30000).expect(201);
    A.pay1 = res.body.id;
    expect(res.body).toMatchObject({ number: 1, balanceAfter: 12000 });
    const jan = await invoiceOf(A.id, A.s1, '2026-01');
    const feb = await invoiceOf(A.id, A.s1, '2026-02');
    expect([jan.status, Number(jan.paidAmount)]).toEqual(['paid', 21000]);
    expect([feb.status, Number(feb.paidAmount)]).toEqual(['partial', 9000]);
  });

  it('rechaza pagos mayores a la deuda y con fecha futura', async () => {
    await pay(A.token, A.s1, 20000).expect(400);
    await pay(A.token, A.s1, 1000, '2099-01-01').expect(400);
  });

  it('dos pagos simultáneos por el saldo completo: solo uno se aplica', async () => {
    const [r1, r2] = await Promise.all([pay(A.token, A.s1, 12000), pay(A.token, A.s1, 12000)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 400]);
    const feb = await invoiceOf(A.id, A.s1, '2026-02');
    expect([feb.status, Number(feb.paidAmount)]).toEqual(['paid', 21000]);
    const numbers = (await owner.payment.findMany({ where: { organizationId: A.id }, select: { number: true } })).map((p) => p.number).sort();
    expect(numbers).toEqual([1, 2]);
  });

  it('no se puede anular una facturación con abonos', async () => {
    await http.post('/api/v1/billing/periods/2026-02/void').set(auth(A.token)).send({ reason: 'Prueba de anulación' }).expect(409);
  });

  it('anular un pago devuelve el saldo a las facturas', async () => {
    await http.post(`/api/v1/payments/${A.pay1}/void`).set(auth(A.token)).send({ reason: 'Error de digitación' }).expect(201);
    const jan = await invoiceOf(A.id, A.s1, '2026-01');
    const feb = await invoiceOf(A.id, A.s1, '2026-02');
    expect([jan.status, Number(jan.paidAmount)]).toEqual(['issued', 0]);
    expect([feb.status, Number(feb.paidAmount)]).toEqual(['partial', 12000]);
    await http.post(`/api/v1/payments/${A.pay1}/void`).set(auth(A.token)).send({ reason: 'Otra vez' }).expect(400);
  });

  it('comprobante y caja', async () => {
    const rc = await http.get(`/api/v1/payments/${A.pay1}`).set(auth(A.token)).expect(200);
    expect(rc.body.payment).toMatchObject({ number: 1, status: 'void', amount: 30000 });
    expect(rc.body.payment.allocations.map((a: any) => a.period)).toEqual(['2026-01', '2026-02']);
    expect(rc.body.balanceNow).toBe(30000);

    const caja = await http.get('/api/v1/payments?from=2026-03-01&to=2026-03-31').set(auth(A.token)).expect(200);
    expect(caja.body).toMatchObject({ count: 1, total: 12000, byMethod: { efectivo: 12000 } });
    expect(caja.body.payments).toHaveLength(2); // el anulado aparece, pero no suma
  });

  it('cartera por edades y candidatos a suspensión', async () => {
    const res = await http.get('/api/v1/receivables?asOf=2026-04-01&minOverdue=2').set(auth(A.token)).expect(200);
    // s1: ene 21.000 (45 días) + feb 9.000 (17 días). s2: ene 21.000 + feb 21.000.
    expect(res.body).toMatchObject({ total: 72000, overdue: 72000, subscribersWithDebt: 2, suspensionCandidates: 2 });
    expect(res.body.buckets).toMatchObject({ current: 0, d1_30: 30000, d31_60: 42000 });
    const s2 = res.body.rows.find((r: any) => r.subscriber.id === A.s2);
    expect(s2).toMatchObject({ balance: 42000, overdueInvoices: 2, maxDaysPastDue: 45, suspensionCandidate: true });

    const early = await http.get('/api/v1/receivables?asOf=2026-03-01&minOverdue=2').set(auth(A.token)).expect(200);
    expect(early.body.suspensionCandidates).toBe(0); // solo enero estaba vencida
    expect(early.body.buckets.current).toBe(30000);
  });

  it('el tablero muestra recaudo del mes y cartera', async () => {
    const res = await http.get('/api/v1/dashboard?period=2026-03').set(auth(A.token)).expect(200);
    expect(res.body).toMatchObject({ collected: { amount: 12000, count: 1 }, receivables: 72000 });
  });

  describe('aislamiento', () => {
    it('B no encuentra, no paga y no ve pagos ni estados de cuenta de A', async () => {
      expect((await http.get(`/api/v1/payments/lookup?q=001-${A.feb1}`).set(auth(B.token)).expect(200)).body
        .every((s: any) => s.subscriber.id !== A.s1)).toBe(true);
      await pay(B.token, A.s1, 1000).expect(404);
      await http.get(`/api/v1/payments/${A.pay1}`).set(auth(B.token)).expect(404);
      await http.get(`/api/v1/payments/statement/${A.s1}`).set(auth(B.token)).expect(404);
      await http.post(`/api/v1/payments/${A.pay1}/void`).set(auth(B.token)).send({ reason: 'intento ajeno' }).expect(404);
      const rec = await http.get('/api/v1/receivables?asOf=2026-04-01').set(auth(B.token)).expect(200);
      expect(rec.body.rows.map((r: any) => r.subscriber.id)).toEqual([B.s1]);
    });

    it('la BD impide aplicar un abono de A a una factura de B (FK compuesta)', async () => {
      const p = await owner.payment.findFirstOrThrow({ where: { organizationId: A.id, status: 'applied' } });
      await expect(
        appRole.$transaction([
          appRole.$executeRaw`SELECT set_config('app.current_org', ${A.id}, TRUE)`,
          appRole.$executeRaw`INSERT INTO tenant.payment_allocations (id, organization_id, payment_id, invoice_id, amount)
            VALUES (gen_random_uuid(), ${A.id}::uuid, ${p.id}::uuid, ${B.invoiceId}::uuid, 1)`,
        ]),
      ).rejects.toThrow(/foreign key|allocations_invoice_same_org_fkey/);
    });

    it('la BD impide abonar más que el total de una factura', async () => {
      const jan = await invoiceOf(A.id, A.s1, '2026-01');
      await expect(
        appRole.$transaction([
          appRole.$executeRaw`SELECT set_config('app.current_org', ${A.id}, TRUE)`,
          appRole.$executeRaw`UPDATE tenant.invoices SET paid_amount = total + 1 WHERE id = ${jan.id}::uuid`,
        ]),
      ).rejects.toThrow(/invoices_paid_within_total/);
    });
  });
});
