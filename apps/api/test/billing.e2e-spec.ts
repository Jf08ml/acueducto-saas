/**
 * Facturación del servicio de acueducto.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';

const run = (Date.now() + 3).toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const appRole = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const P = '2026-01';

const TARIFF = {
  name: 'Tarifa prueba', effectiveFrom: '2026-01-01', billingPeriod: 'monthly', basicConsumptionM3: 16,
  fixedCharge: 8500, rateBasic: 1250, rateComplementary: 1600, rateSumptuary: 1900,
  stratumFactors: { '1': -50, '2': -40, '3': -15, '4': 0, '5': 50, comercial: 50 },
};

describe('Facturación', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const A = { id: '', token: '', s1: '', s2: '', s3: '', m1: '', m2: '', invoiceId: '' };
  const B = { id: '', token: '', s1: '', m1: '', invoiceId: '' };

  async function register(tag: string, suffix: string) {
    const nit = `6${run}${suffix}`;
    const email = `bill-${tag}-${run}@test.co`;
    const reg = await http.post('/api/v1/onboarding/organizations').send({
      name: `Acueducto Bill ${tag} ${run}`, legalName: `Asociación Bill ${tag}`, nit, nitDv: nitCheckDigit(nit),
      department: 'Nariño', municipality: 'Ipiales', organizationType: 'asociacion_usuarios', estimatedSubscribers: 10,
      contactEmail: email, contactPhone: '3001234567', owner: { fullName: `Dueño ${tag}`, email, password: 'Clave12345!' },
    }).expect(201);
    const token = (await http.post('/api/v1/auth/login').send({ email, password: 'Clave12345!' }).expect(201)).body.accessToken;
    return { id: reg.body.organizationId as string, token: token as string };
  }
  const sub = async (token: string, body: any) => (await http.post('/api/v1/subscribers').set(auth(token)).send(body).expect(201)).body.id as string;
  const meter = async (token: string, subscriberId: string, serial: string, initialReading: number) =>
    (await http.post('/api/v1/meters').set(auth(token)).send({ subscriberId, serial, installedAt: '2025-12-01', initialReading }).expect(201)).body.id as string;
  const read = (token: string, meterId: string, value: number) =>
    http.post('/api/v1/readings').set(auth(token)).send({ period: P, readingDate: '2026-01-28', entries: [{ meterId, value }] });
  const OPTS = { missingReadings: 'block', unmeteredConsumptionM3: 10 };

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    Object.assign(A, await register('A', '7'));
    Object.assign(B, await register('B', '8'));

    await http.put('/api/v1/setup/tariff').set(auth(A.token)).send(TARIFF).expect(200);
    A.s1 = await sub(A.token, { code: '001', fullName: 'Ana Estrato Uno', documentNumber: '111', address: 'Vereda 1', stratum: 1 });
    A.s2 = await sub(A.token, { code: '002', fullName: 'Tienda La Esquina', documentNumber: '222', address: 'Centro', stratum: 3, usage: 'comercial' });
    A.s3 = await sub(A.token, { code: '003', fullName: 'Carlos Sin Medidor', documentNumber: '333', address: 'Vereda 2', stratum: 4 });
    A.m1 = await meter(A.token, A.s1, `BA1-${run}`, 100);
    A.m2 = await meter(A.token, A.s2, `BA2-${run}`, 0);
    await read(A.token, A.m1, 120).expect(201); // 20 m³

    B.s1 = await sub(B.token, { code: '001', fullName: 'Usuario B', documentNumber: '999', address: 'Vereda B', stratum: 2 });
    B.m1 = await meter(B.token, B.s1, `BB1-${run}`, 0);
    await read(B.token, B.m1, 5).expect(201);
  });

  afterAll(async () => {
    const ids = [A.id, B.id].filter(Boolean);
    const where = { organizationId: { in: ids } };
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

  it('sin tarifa vigente no se puede facturar', async () => {
    await http.post('/api/v1/billing/preview').set(auth(B.token)).send({ period: P, options: OPTS }).expect(400);
  });

  it('si faltan lecturas, la previsualización avisa y la emisión se bloquea', async () => {
    const pv = await http.post('/api/v1/billing/preview').set(auth(A.token)).send({ period: P, options: OPTS }).expect(201);
    expect(pv.body.canIssue).toBe(false);
    expect(pv.body.warnings.missingReadings.map((m: any) => m.code)).toEqual(['002']);
    const res = await http.post('/api/v1/billing/issue').set(auth(A.token))
      .send({ period: P, options: OPTS, issueDate: '2026-02-01', dueDate: '2026-02-15' }).expect(400);
    expect(res.body.code).toBe('MISSING_READINGS');
  });

  it('la previsualización calcula subsidio, contribución y aforo sin guardar nada', async () => {
    await read(A.token, A.m2, 10).expect(201); // 10 m³ comercial
    const pv = await http.post('/api/v1/billing/preview').set(auth(A.token)).send({ period: P, options: OPTS }).expect(201);
    const by = Object.fromEntries(pv.body.rows.map((r: any) => [r.code, r]));
    expect(by['001']).toMatchObject({ consumptionM3: 20, subsidy: -14250, total: 20650 }); // estrato 1
    expect(by['002']).toMatchObject({ consumptionM3: 10, contribution: 10500, total: 31500 }); // comercial
    expect(by['003']).toMatchObject({ consumptionM3: 10, flag: 'sin_medidor', total: 21000 }); // aforo 10 m³, estrato 4
    expect(pv.body.totals).toMatchObject({ invoices: 3, total: 73150 });
    expect(pv.body.canIssue).toBe(true);
    expect(await owner.invoice.count({ where: { organizationId: A.id } })).toBe(0);
  });

  it('la fecha límite no puede ser anterior a la expedición', async () => {
    await http.post('/api/v1/billing/issue').set(auth(A.token))
      .send({ period: P, options: OPTS, issueDate: '2026-02-10', dueDate: '2026-02-01' }).expect(400);
  });

  it('emite las facturas con numeración consecutiva y bloquea las lecturas', async () => {
    const res = await http.post('/api/v1/billing/issue').set(auth(A.token))
      .send({ period: P, options: OPTS, issueDate: '2026-02-01', dueDate: '2026-02-15' }).expect(201);
    expect(res.body).toMatchObject({ invoices: 3, total: 73150, firstNumber: 1, lastNumber: 3 });

    const again = await read(A.token, A.m1, 130).expect(201);
    expect(again.body.results[0]).toMatchObject({ ok: false, error: 'El período ya fue facturado' });
    await http.post('/api/v1/billing/issue').set(auth(A.token))
      .send({ period: P, options: OPTS, issueDate: '2026-02-01', dueDate: '2026-02-15' }).expect(409);
  });

  it('el recibo trae líneas, datos del emisor e historial', async () => {
    const period = await http.get(`/api/v1/billing/periods/${P}`).set(auth(A.token)).expect(200);
    expect(period.body).toMatchObject({ status: 'issued', invoiceCount: 3 });
    A.invoiceId = period.body.invoices.find((i: any) => i.subscriberSnapshot.code === '001').id;

    const inv = await http.get(`/api/v1/invoices/${A.invoiceId}`).set(auth(A.token)).expect(200);
    expect(inv.body.issuer.nit).toMatch(/^6\d+-\d$/);
    const r = inv.body.invoices[0];
    expect(r.lines.map((l: any) => l.concept)).toEqual(['cargo_fijo', 'consumo_basico', 'consumo_complementario', 'subsidio']);
    expect(Number(r.total)).toBe(20650);
    expect(r.readingSnapshot).toMatchObject({ previousValue: 100, currentValue: 120, consumptionM3: 20 });

    const all = await http.get(`/api/v1/billing/periods/${P}/receipts`).set(auth(A.token)).expect(200);
    expect(all.body.invoices).toHaveLength(3);
  });

  it('editar el suscriptor no cambia la factura ya emitida', async () => {
    await http.patch(`/api/v1/subscribers/${A.s1}`).set(auth(A.token)).send({ fullName: 'Ana María Estrato Uno' }).expect(200);
    const inv = await http.get(`/api/v1/invoices/${A.invoiceId}`).set(auth(A.token)).expect(200);
    expect(inv.body.invoices[0].subscriberSnapshot.fullName).toBe('Ana Estrato Uno');
  });

  it('B no ve facturas, períodos ni puede editar suscriptores de A', async () => {
    await http.get(`/api/v1/invoices/${A.invoiceId}`).set(auth(B.token)).expect(404);
    await http.get(`/api/v1/billing/periods/${P}`).set(auth(B.token)).expect(404);
    expect((await http.get('/api/v1/billing/periods').set(auth(B.token)).expect(200)).body).toEqual([]);
    await http.patch(`/api/v1/subscribers/${A.s1}`).set(auth(B.token)).send({ fullName: 'Hackeado' }).expect(404);
  });

  it('anular libera las lecturas y una nueva emisión continúa la numeración', async () => {
    await http.post(`/api/v1/billing/periods/${P}/void`).set(auth(A.token)).send({ reason: 'x' }).expect(400);
    await http.post(`/api/v1/billing/periods/${P}/void`).set(auth(A.token)).send({ reason: 'Error en la tarifa' }).expect(201);
    expect(await owner.invoice.count({ where: { organizationId: A.id, status: 'void' } })).toBe(3);

    const fix = await read(A.token, A.m1, 118).expect(201); // ahora sí se puede corregir: 18 m³
    expect(fix.body.results[0]).toMatchObject({ ok: true, consumptionM3: 18 });

    const res = await http.post('/api/v1/billing/issue').set(auth(A.token))
      .send({ period: P, options: OPTS, issueDate: '2026-02-02', dueDate: '2026-02-16' }).expect(201);
    expect(res.body).toMatchObject({ firstNumber: 4, lastNumber: 6 });
    const period = await http.get(`/api/v1/billing/periods/${P}`).set(auth(A.token)).expect(200);
    expect(period.body.invoices.filter((i: any) => i.status === 'issued')).toHaveLength(3);
  });

  it('cada acueducto tiene su propia numeración', async () => {
    await http.put('/api/v1/setup/tariff').set(auth(B.token)).send(TARIFF).expect(200);
    const res = await http.post('/api/v1/billing/issue').set(auth(B.token))
      .send({ period: P, options: OPTS, issueDate: '2026-02-01', dueDate: '2026-02-15' }).expect(201);
    expect(res.body).toMatchObject({ invoices: 1, firstNumber: 1 });
    B.invoiceId = (await http.get(`/api/v1/billing/periods/${P}`).set(auth(B.token)).expect(200)).body.invoices[0].id;
  });

  it('la BD impide agregar una línea de A a una factura de B (FK compuesta)', async () => {
    await expect(
      appRole.$transaction([
        appRole.$executeRaw`SELECT set_config('app.current_org', ${A.id}, TRUE)`,
        appRole.$executeRaw`INSERT INTO tenant.invoice_lines (id, organization_id, invoice_id, concept, description, quantity, unit_price, amount, sort_order)
          VALUES (gen_random_uuid(), ${A.id}::uuid, ${B.invoiceId}::uuid, 'cargo_fijo', 'x', 1, 1, 1, 0)`,
      ]),
    ).rejects.toThrow(/foreign key|invoice_lines_invoice_same_org_fkey/);
  });
});
