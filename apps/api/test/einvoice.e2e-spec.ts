/**
 * Base de facturación electrónica: configuración con clave técnica cifrada, numeración del rango autorizado,
 * envío por la cola al proveedor (simulado), reintento de errores, anulación y aislamiento entre acueductos.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';
import { EInvoiceService, SimulatedProvider } from '../src/einvoice/einvoice.module';
import { decryptSecret } from '../src/common/secrets';
import { sid } from './helpers';

const run = (Date.now() + 11).toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const TARIFF = {
  name: 'Tarifa FE', effectiveFrom: '2026-01-01', billingPeriod: 'monthly', basicConsumptionM3: 16,
  fixedCharge: 8500, rateBasic: 1250, rateComplementary: 1600, rateSumptuary: 1900, stratumFactors: { '1': -50, '2': -40 },
};
const OPTS = { missingReadings: 'block', unmeteredConsumptionM3: 10 };
const CONFIG = {
  enabled: true, provider: 'simulated', environment: 'habilitacion', documentType: 'documento_equivalente_spd',
  resolution: { number: '18760000001', date: '2026-01-15', prefix: 'SPD', rangeFrom: 1, rangeTo: 3, validFrom: '2026-01-01', validTo: '2030-12-31' },
  technicalKey: 'clave-tecnica-secreta-123',
};

describe('Facturación electrónica (base)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let einvoice: EInvoiceService;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const A = { id: '', token: '' };
  const B = { id: '', token: '' };

  async function register(o: { id: string; token: string }, tag: string, suffix: string) {
    const nit = `4${run}${suffix}`;
    const email = `fe-${tag}-${run}@test.co`;
    const reg = await http.post('/api/v1/onboarding/organizations').send({
      name: `Acueducto FE ${tag} ${run}`, legalName: `Asociación FE ${tag}`, nit, nitDv: nitCheckDigit(nit), department: 'Nariño', municipality: 'Ipiales',
      organizationType: 'asociacion_usuarios', estimatedSubscribers: 10, contactEmail: email, contactPhone: '3001234567',
      owner: { fullName: `Dueño ${tag}`, email, password: 'Clave12345!' },
    }).expect(201);
    o.id = reg.body.organizationId;
    o.token = sid(await http.post('/api/v1/auth/login').send({ email, password: 'Clave12345!' }).expect(201));
    await http.put('/api/v1/setup/tariff').set(auth(o.token)).send(TARIFF).expect(200);
  }
  async function subscriberWithReading(token: string, code: string, period: string, value: number, serial: string) {
    const s = (await http.post('/api/v1/subscribers').set(auth(token)).send({ code, fullName: `Suscriptor ${code}`, documentNumber: `10${code}`, address: 'Vereda', stratum: 1 }).expect(201)).body.id;
    const m = (await http.post('/api/v1/meters').set(auth(token)).send({ subscriberId: s, serial, installedAt: '2025-12-01', initialReading: 0 }).expect(201)).body.id;
    await http.post('/api/v1/readings').set(auth(token)).send({ period, readingDate: `${period}-28`, entries: [{ meterId: m, value }] }).expect(201);
    return m;
  }
  const issue = (token: string, period: string) => http.post('/api/v1/billing/issue').set(auth(token))
    .send({ period, options: OPTS, issueDate: `${period}-28`, dueDate: `${period}-28` });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    einvoice = app.get(EInvoiceService);
    await register(A, 'A', '1');
    await register(B, 'B', '2');
  });

  afterAll(async () => {
    einvoice.useProvider(new SimulatedProvider());
    const where = { organizationId: { in: [A.id, B.id].filter(Boolean) } };
    await owner.eInvoiceDocument.deleteMany({ where });
    await owner.eInvoiceConfig.deleteMany({ where });
    await owner.invoiceLine.deleteMany({ where });
    await owner.invoice.deleteMany({ where });
    await owner.billingPeriod.deleteMany({ where });
    await owner.meterReading.deleteMany({ where });
    await owner.meter.deleteMany({ where });
    await owner.tariffSchedule.deleteMany({ where });
    await owner.subscriber.deleteMany({ where });
    const users = await owner.membership.findMany({ where, select: { userId: true } });
    await owner.organization.deleteMany({ where: { id: where.organizationId } });
    await owner.user.deleteMany({ where: { id: { in: users.map((u) => u.userId) } } });
    await Promise.all([owner.$disconnect(), app?.close()]);
  });

  it('sin configurar, emitir no crea documentos electrónicos', async () => {
    await subscriberWithReading(B.token, '001', '2026-01', 10, `FEB1-${run}`);
    const res = await issue(B.token, '2026-01').expect(201);
    expect(res.body.einvoiceJobId).toBeNull();
    expect(await owner.eInvoiceDocument.count({ where: { organizationId: B.id } })).toBe(0);
  });

  it('configuración: valida la resolución, cifra la clave técnica y nunca la devuelve', async () => {
    await http.put('/api/v1/einvoice/config').set(auth(A.token)).send({ ...CONFIG, environment: 'produccion' }).expect(400);
    const res = await http.put('/api/v1/einvoice/config').set(auth(A.token)).send(CONFIG).expect(200);
    expect(res.body.config).toMatchObject({ enabled: true, hasTechnicalKey: true, resolution: { prefix: 'SPD', rangeTo: 3 } });
    expect(JSON.stringify(res.body)).not.toContain('clave-tecnica');
    const row = await owner.eInvoiceConfig.findUniqueOrThrow({ where: { organizationId: A.id } });
    expect(row.technicalKeyEncrypted).not.toContain('clave-tecnica');
    expect(decryptSecret(row.technicalKeyEncrypted!)).toBe(CONFIG.technicalKey);
    // Guardar sin clave conserva la anterior.
    const { technicalKey: _k, ...noKey } = CONFIG;
    await http.put('/api/v1/einvoice/config').set(auth(A.token)).send(noKey).expect(200);
    expect((await owner.eInvoiceConfig.findUniqueOrThrow({ where: { organizationId: A.id } })).technicalKeyEncrypted).toBe(row.technicalKeyEncrypted);
    // B no ve la configuración de A (RLS).
    expect((await http.get('/api/v1/einvoice/config').set(auth(B.token)).expect(200)).body.config).toBeNull();
  });

  it('al emitir, cada factura recibe un número del rango y el proveedor la acepta', async () => {
    await subscriberWithReading(A.token, '001', '2026-01', 12, `FEA1-${run}`);
    await subscriberWithReading(A.token, '002', '2026-01', 30, `FEA2-${run}`);
    const res = await issue(A.token, '2026-01').expect(201);
    const job = await http.get(`/api/v1/jobs/${res.body.einvoiceJobId}`).set(auth(A.token)).expect(200);
    expect(job.body).toMatchObject({ status: 'done', result: { created: 2, accepted: 2 } });

    const docs = await owner.eInvoiceDocument.findMany({ where: { organizationId: A.id }, orderBy: { number: 'asc' } });
    expect(docs.map((d) => `${d.prefix}${d.number}`)).toEqual(['SPD1', 'SPD2']);
    expect(docs.every((d) => d.status === 'accepted' && /^[0-9a-f]{96}$/.test(d.documentKey ?? ''))).toBe(true);
    expect((docs[0].payload as any)).toMatchObject({ fullNumber: 'SPD1', currency: 'COP', service: { period: '2026-01' } });

    const inv = await http.get(`/api/v1/invoices/${docs[0].invoiceId}`).set(auth(A.token)).expect(200);
    expect(inv.body.invoices[0].electronicDocument).toMatchObject({ status: 'accepted', prefix: 'SPD', number: 1 });
    expect((await http.get('/api/v1/einvoice/periods/2026-01').set(auth(A.token)).expect(200)).body.counts).toEqual({ accepted: 2 });
    // B no ve los documentos de A.
    expect((await http.get('/api/v1/einvoice/periods/2026-01').set(auth(B.token)).expect(200)).body.counts).toEqual({});
  });

  it('si el rango no alcanza para todo el período, no numera ninguna (todo o nada)', async () => {
    await subscriberWithReading(A.token, '003', '2026-02', 8, `FEA3-${run}`);
    const meters = await owner.meter.findMany({ where: { organizationId: A.id, serial: { in: [`FEA1-${run}`, `FEA2-${run}`] } } });
    for (const m of meters) await http.post('/api/v1/readings').set(auth(A.token)).send({ period: '2026-02', readingDate: '2026-02-28', entries: [{ meterId: m.id, value: 50 }] }).expect(201);

    // Rango 1-3 con dos usados en enero: las tres facturas de febrero no caben.
    const res = await issue(A.token, '2026-02').expect(201);
    const job = await http.get(`/api/v1/jobs/${res.body.einvoiceJobId}`).set(auth(A.token)).expect(200);
    expect(job.body.status).toBe('failed');
    expect(job.body.error).toMatch(/agotó el rango/);
    expect(await owner.eInvoiceDocument.count({ where: { organizationId: A.id, period: '2026-02' } })).toBe(0);
  });

  it('si el proveedor falla, queda con error y el reintento lo envía sin repetir números', async () => {
    await http.put('/api/v1/einvoice/config').set(auth(A.token)).send({ ...CONFIG, technicalKey: undefined, resolution: { ...CONFIG.resolution, rangeTo: 100 } }).expect(200);
    let fail = true;
    const sim = new SimulatedProvider();
    einvoice.useProvider({ key: 'simulated', send: async (p, c) => { if (fail) throw new Error('Proveedor caído'); return sim.send(p, c); } });

    const r1 = await http.post('/api/v1/einvoice/periods/2026-02/retry').set(auth(A.token)).expect(200);
    expect((await http.get(`/api/v1/jobs/${r1.body.id}`).set(auth(A.token)).expect(200)).body.result).toMatchObject({ created: 3, errors: 3 });
    const st = await http.get('/api/v1/einvoice/periods/2026-02').set(auth(A.token)).expect(200);
    expect(st.body.counts).toEqual({ error: 3 });
    expect(st.body.problems[0].lastError).toBe('Proveedor caído');

    fail = false;
    const r2 = await http.post('/api/v1/einvoice/periods/2026-02/retry').set(auth(A.token)).expect(200);
    expect((await http.get(`/api/v1/jobs/${r2.body.id}`).set(auth(A.token)).expect(200)).body.result).toMatchObject({ created: 0, accepted: 3 });
    const docs = await owner.eInvoiceDocument.findMany({ where: { organizationId: A.id, period: '2026-02' }, orderBy: { number: 'asc' } });
    expect(docs.map((d) => [d.number, d.status, d.attempts])).toEqual([[3, 'accepted', 2], [4, 'accepted', 2], [5, 'accepted', 2]]);
  });

  it('anular una facturación ya aceptada la marca para nota crédito', async () => {
    await http.post('/api/v1/billing/periods/2026-02/void').set(auth(A.token)).send({ reason: 'Error en las lecturas' }).expect(201);
    expect((await http.get('/api/v1/einvoice/periods/2026-02').set(auth(A.token)).expect(200)).body.counts).toEqual({ requires_credit_note: 3 });
  });

  it('una resolución vencida no numera', async () => {
    await http.put('/api/v1/einvoice/config').set(auth(B.token)).send({ ...CONFIG, resolution: { ...CONFIG.resolution, validFrom: '2020-01-01', validTo: '2020-12-31' } }).expect(200);
    await subscriberWithReading(B.token, '002', '2026-02', 9, `FEB2-${run}`);
    const meter = await owner.meter.findFirstOrThrow({ where: { organizationId: B.id, serial: `FEB1-${run}` } });
    await http.post('/api/v1/readings').set(auth(B.token)).send({ period: '2026-02', readingDate: '2026-02-28', entries: [{ meterId: meter.id, value: 20 }] }).expect(201);
    const res = await issue(B.token, '2026-02').expect(201); // la facturación del agua sí se emite
    const job = await http.get(`/api/v1/jobs/${res.body.einvoiceJobId}`).set(auth(B.token)).expect(200);
    expect(job.body).toMatchObject({ status: 'failed' });
    expect(job.body.error).toMatch(/no está vigente/);
  });
});
