/**
 * Intereses de mora, cargos adicionales, suspensión y reconexión.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';

const run = (Date.now() + 6).toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const TARIFF = {
  name: 'Tarifa', effectiveFrom: '2026-01-01', billingPeriod: 'monthly', basicConsumptionM3: 16,
  fixedCharge: 8500, rateBasic: 1250, rateComplementary: 1600, rateSumptuary: 1900, stratumFactors: { '4': 0 },
};
const OPTS = { missingReadings: 'block', unmeteredConsumptionM3: null };
const SETTINGS = { lateInterestEnabled: true, residentialMonthlyRatePct: 1, nonResidentialMonthlyRatePct: 2, graceDays: 0, reconnectionFee: 25000, suspensionMinOverdue: 1 };

describe('Cobro: intereses, cargos, suspensión y reconexión', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const A = { id: '', token: '', s1: '', s2: '', m1: '', m2: '' };
  const B = { id: '', token: '' };

  async function register(tag: string, suffix: string) {
    const nit = `3${run}${suffix}`;
    const email = `col-${tag}-${run}@test.co`;
    const reg = await http.post('/api/v1/onboarding/organizations').send({
      name: `Acueducto Col ${tag} ${run}`, legalName: `Asociación Col ${tag}`, nit, nitDv: nitCheckDigit(nit),
      department: 'Huila', municipality: 'Pitalito', organizationType: 'comunitario', estimatedSubscribers: 10,
      contactEmail: email, contactPhone: '3001234567', owner: { fullName: `Dueño ${tag}`, email, password: 'Clave12345!' },
    }).expect(201);
    const token = (await http.post('/api/v1/auth/login').send({ email, password: 'Clave12345!' }).expect(201)).body.accessToken;
    await http.put('/api/v1/setup/tariff').set({ Authorization: `Bearer ${token}` }).send(TARIFF).expect(200);
    return { id: reg.body.organizationId as string, token: token as string };
  }
  const read = (period: string, v1: number, v2: number) =>
    http.post('/api/v1/readings').set(auth(A.token)).send({ period, readingDate: `${period}-25`, entries: [{ meterId: A.m1, value: v1 }, { meterId: A.m2, value: v2 }] }).expect(201);
  const issue = (period: string, issueDate: string, dueDate: string) =>
    http.post('/api/v1/billing/issue').set(auth(A.token)).send({ period, options: OPTS, issueDate, dueDate });
  const inv = (subscriberId: string, period: string) =>
    owner.invoice.findFirstOrThrow({ where: { organizationId: A.id, subscriberId, period, status: { not: 'void' } }, include: { lines: true } });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    Object.assign(A, await register('A', '1'));
    Object.assign(B, await register('B', '2'));
    A.s1 = (await http.post('/api/v1/subscribers').set(auth(A.token)).send({ code: '001', fullName: 'Residencial Uno', documentNumber: '111', address: 'Vereda', stratum: 4 }).expect(201)).body.id;
    A.s2 = (await http.post('/api/v1/subscribers').set(auth(A.token)).send({ code: '002', fullName: 'Tienda Dos', documentNumber: '222', address: 'Centro', stratum: 4, usage: 'comercial' }).expect(201)).body.id;
    A.m1 = (await http.post('/api/v1/meters').set(auth(A.token)).send({ subscriberId: A.s1, serial: `C1-${run}`, installedAt: '2025-12-01', initialReading: 0 }).expect(201)).body.id;
    A.m2 = (await http.post('/api/v1/meters').set(auth(A.token)).send({ subscriberId: A.s2, serial: `C2-${run}`, installedAt: '2025-12-01', initialReading: 0 }).expect(201)).body.id;
    await read('2026-01', 10, 10); // 21.000 cada uno
    await issue('2026-01', '2026-01-31', '2026-02-15').expect(201);
  });

  afterAll(async () => {
    const ids = [A.id, B.id].filter(Boolean);
    const where = { organizationId: { in: ids } };
    await owner.serviceEvent.deleteMany({ where });
    await owner.subscriberCharge.deleteMany({ where });
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
    await owner.$disconnect();
    await app?.close();
  });

  it('por defecto no se cobran intereses; la configuración se valida y se guarda', async () => {
    const def = await http.get('/api/v1/collections/settings').set(auth(A.token)).expect(200);
    expect(def.body.lateInterestEnabled).toBe(false);
    await http.put('/api/v1/collections/settings').set(auth(A.token)).send({ ...SETTINGS, residentialMonthlyRatePct: 9 }).expect(400);
    await http.put('/api/v1/collections/settings').set(auth(A.token)).send(SETTINGS).expect(200);
  });

  it('intereses de mora por días, con tasa según el uso', async () => {
    await read('2026-02', 20, 20);
    const pv = await http.post('/api/v1/billing/preview').set(auth(A.token)).send({ period: '2026-02', options: OPTS, issueDate: '2026-03-17' }).expect(201);
    const by = Object.fromEntries(pv.body.rows.map((r: any) => [r.code, r]));
    // 30 días de mora sobre 21.000: residencial 1% → 210, comercial 2% → 420.
    expect(by['001']).toMatchObject({ interest: 210, total: 21210 });
    expect(by['002']).toMatchObject({ interest: 420, total: 21420 });
    expect(pv.body.totals.interest).toBe(630);

    await issue('2026-02', '2026-03-17', '2026-03-31').expect(201);
    const feb = await inv(A.s1, '2026-02');
    expect(Number(feb.interestAmount)).toBe(210);
    expect(feb.lines.find((l) => l.concept === 'interes_mora')).toBeTruthy();
  });

  it('la lista de suspensión usa el umbral configurado y la suspensión queda registrada', async () => {
    const rec = await http.get('/api/v1/receivables?asOf=2026-04-01').set(auth(A.token)).expect(200);
    expect(rec.body.minOverdue).toBe(1);
    expect(rec.body.suspensionCandidates).toBe(2);

    await http.post(`/api/v1/collections/subscribers/${A.s1}/suspend`).set(auth(A.token)).send({ date: '2026-04-02', reason: 'Dos facturas vencidas' }).expect(201);
    await http.post(`/api/v1/collections/subscribers/${A.s1}/suspend`).set(auth(A.token)).send({ date: '2026-04-02', reason: 'Otra vez' }).expect(400);
    const after = await http.get('/api/v1/receivables?asOf=2026-04-02').set(auth(A.token)).expect(200);
    expect(after.body).toMatchObject({ suspensionCandidates: 1, suspended: 1 });
  });

  it('reconectar exige estar al día o registrar el acuerdo, y genera el cargo de reconexión', async () => {
    const debt = await http.post(`/api/v1/collections/subscribers/${A.s1}/reconnect`).set(auth(A.token)).send({ date: '2026-04-05', reconnectionFee: null }).expect(400);
    expect(debt.body.code).toBe('DEBT_PENDING');
    await http.post(`/api/v1/collections/subscribers/${A.s1}/reconnect`).set(auth(A.token)).send({ date: '2026-04-05', reconnectionFee: null, allowWithDebt: true }).expect(400);
    const ok = await http.post(`/api/v1/collections/subscribers/${A.s1}/reconnect`).set(auth(A.token))
      .send({ date: '2026-04-05', reconnectionFee: null, allowWithDebt: true, notes: 'Acuerdo de pago a 3 cuotas' }).expect(201);
    expect(ok.body.reconnectionFee).toBe(25000);

    const ev = await http.get(`/api/v1/collections/subscribers/${A.s1}/events`).set(auth(A.token)).expect(200);
    expect(ev.body.serviceStatus).toBe('connected');
    expect(ev.body.events.map((e: any) => e.type)).toEqual(['reconnection', 'suspension']);
    expect(ev.body.events[0].balanceAtEvent).toBe(42210);
  });

  it('cargos manuales: se anulan si aún no se facturan', async () => {
    const c = await http.post('/api/v1/collections/charges').set(auth(A.token)).send({ subscriberId: A.s2, description: 'Arreglo de acometida', amount: 15000 }).expect(201);
    await http.delete(`/api/v1/collections/charges/${c.body.id}`).set(auth(A.token)).expect(204);
    await http.delete(`/api/v1/collections/charges/${c.body.id}`).set(auth(A.token)).expect(400);
  });

  it('la siguiente factura incluye la reconexión y no cobra intereses dos veces ni sobre intereses', async () => {
    await read('2026-03', 30, 30);
    await issue('2026-03', '2026-04-16', '2026-04-30').expect(201);
    const mar = await inv(A.s1, '2026-03');
    // Enero: 21.000 desde el 17-mar (último cobro) → 30 días → 210.
    // Febrero: capital 21.000 (sin los 210 de interés) desde su vencimiento 31-mar → 16 días → 112.
    expect(Number(mar.interestAmount)).toBe(322);
    expect(mar.lines.find((l) => l.concept === 'reconexion')).toMatchObject({ description: 'Cargo por reconexión del servicio' });
    expect(Number(mar.total)).toBe(21000 + 322 + 25000);
    const charges = await http.get(`/api/v1/collections/charges?subscriberId=${A.s1}`).set(auth(A.token)).expect(200);
    expect(charges.body[0]).toMatchObject({ concept: 'reconexion', status: 'billed', billedInvoice: { period: '2026-03' } });
    expect((await http.get(`/api/v1/payments/statement/${A.s1}`).set(auth(A.token)).expect(200)).body.pendingCharges).toEqual([]);
  });

  it('un cargo facturado no se anula directamente; anular la facturación lo devuelve a pendiente', async () => {
    const charge = (await http.get(`/api/v1/collections/charges?subscriberId=${A.s1}`).set(auth(A.token)).expect(200)).body[0];
    await http.delete(`/api/v1/collections/charges/${charge.id}`).set(auth(A.token)).expect(400);
    await http.post('/api/v1/billing/periods/2026-03/void').set(auth(A.token)).send({ reason: 'Corrección de prueba' }).expect(201);
    expect((await http.get(`/api/v1/collections/charges?subscriberId=${A.s1}`).set(auth(A.token)).expect(200)).body[0].status).toBe('pending');
    // Al reemitir, el piso de intereses vuelve a ser la factura de febrero y el cargo se vuelve a facturar.
    await issue('2026-03', '2026-04-16', '2026-04-30').expect(201);
    const mar = await inv(A.s1, '2026-03');
    expect(Number(mar.interestAmount)).toBe(322);
    expect(mar.lines.some((l) => l.concept === 'reconexion')).toBe(true);
  });

  it('B no suspende, reconecta, carga ni consulta suscriptores de A', async () => {
    await http.post(`/api/v1/collections/subscribers/${A.s2}/suspend`).set(auth(B.token)).send({ date: '2026-04-02', reason: 'Intento ajeno' }).expect(404);
    await http.post(`/api/v1/collections/subscribers/${A.s1}/reconnect`).set(auth(B.token)).send({ date: '2026-04-02', reconnectionFee: 0 }).expect(404);
    await http.post('/api/v1/collections/charges').set(auth(B.token)).send({ subscriberId: A.s2, description: 'Cargo ajeno', amount: 1000 }).expect(404);
    await http.get(`/api/v1/collections/subscribers/${A.s1}/events`).set(auth(B.token)).expect(404);
    expect((await http.get('/api/v1/collections/charges').set(auth(B.token)).expect(200)).body).toEqual([]);
    expect((await http.get('/api/v1/collections/settings').set(auth(B.token)).expect(200)).body.lateInterestEnabled).toBe(false);
  });
});
