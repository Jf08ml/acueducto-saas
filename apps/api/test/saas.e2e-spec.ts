/**
 * Cobro del SaaS: ciclo de vida de la suscripción (prueba → factura → gracia → solo lectura → pago),
 * transferencia con comprobante, Mercado Pago (verificado contra su API), webhook firmado y aislamiento.
 * La revisión diaria se corre con fechas simuladas y limitada a los acueductos de la prueba.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { addDays, nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';
import { SaasService } from '../src/saas/saas.service';
import { MercadoPagoApi, MpPayment } from '../src/saas/mercadopago';
import { sid } from './helpers';

const run = Date.now().toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const PW = 'Clave12345!';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

class FakeMp implements MercadoPagoApi {
  enabled = true;
  payments = new Map<string, MpPayment>();
  preferences: any[] = [];
  async createPreference(input: any) {
    this.preferences.push(input);
    return { id: `pref-${this.preferences.length}`, url: `https://mp.test/checkout/${this.preferences.length}` };
  }
  async getPayment(id: string) {
    return this.payments.get(id) ?? null;
  }
}

describe('Cobro del SaaS', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let saas: SaasService;
  const mp = new FakeMp();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const A = { id: '', token: '' };
  const B = { id: '', token: '' };
  let admin = '';
  let previousSettings: { value: any } | null = null;
  const only = () => ({ organizationIds: [A.id, B.id] });
  const subOf = (id: string) => owner.subscription.findFirstOrThrow({ where: { organizationId: id } });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    saas = app.get(SaasService);
    saas.useMercadoPago(mp);
    for (const [o, tag, nit] of [[A, 'A', `6${run}1`], [B, 'B', `6${run}2`]] as const) {
      const email = `saas-${tag}-${run}@test.co`;
      const reg = await http.post('/api/v1/onboarding/organizations').send({
        name: `Acueducto Cobro ${tag} ${run}`, legalName: `Asociación Cobro ${tag}`, nit, nitDv: nitCheckDigit(nit), department: 'Nariño',
        municipality: 'Pasto', organizationType: 'comunitario', estimatedSubscribers: 10, contactEmail: `c-${email}`, contactPhone: '3001234567',
        owner: { fullName: `Dueño ${tag}`, email, password: PW },
      }).expect(201);
      o.id = reg.body.organizationId;
      o.token = sid(await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(201));
    }
    admin = sid(await http.post('/api/v1/auth/login').send({ email: process.env.SUPERADMIN_EMAIL ?? 'admin@aguamata.local', password: process.env.SUPERADMIN_PASSWORD ?? 'Admin12345!' }).expect(201));
    previousSettings = await owner.platformSetting.findUnique({ where: { key: 'saas' } });
    await saas.updateSettings({
      invoiceLeadDays: 7, graceDays: 5,
      bank: { bankName: 'Banco de Prueba', accountType: 'ahorros', accountNumber: '123-456', holder: 'AguaMata SAS', holderId: '900000000-1', instructions: '' },
    });
  });

  afterAll(async () => {
    // La configuración de cobro es global: se deja como estaba (primero, por si falla lo demás).
    if (previousSettings) await owner.platformSetting.update({ where: { key: 'saas' }, data: { value: previousSettings.value } });
    else await owner.platformSetting.deleteMany({ where: { key: 'saas' } });
    const ids = [A.id, B.id].filter(Boolean);
    const users = await owner.membership.findMany({ where: { organizationId: { in: ids } }, select: { userId: true } });
    await owner.subscriber.deleteMany({ where: { organizationId: { in: ids } } });
    await owner.organization.deleteMany({ where: { id: { in: ids } } });
    await owner.user.deleteMany({ where: { id: { in: users.map((u) => u.userId) } } });
    await Promise.all([owner.$disconnect(), app?.close()]);
  });

  it('el registro crea una prueba del plan único con toda la plataforma', async () => {
    const sub = await owner.subscription.findFirstOrThrow({ where: { organizationId: A.id }, include: { plan: { include: { limits: true, features: true } } } });
    expect(sub).toMatchObject({ status: 'trialing', billingCycle: 'monthly', plan: { code: 'plataforma' } });
    expect(sub.plan.limits.every((l) => l.value === -1)).toBe(true);
    expect(sub.plan.features.every((f) => f.enabled)).toBe(true);
  });

  it('la revisión diaria emite la factura antes del vencimiento, una sola vez', async () => {
    const sub = await subOf(A.id);
    expect((await saas.daily(addDays(sub.currentPeriodEnd, -10), only())).invoiced).toBe(0);
    expect((await saas.daily(addDays(sub.currentPeriodEnd, -3), only())).invoiced).toBe(2);
    expect((await saas.daily(addDays(sub.currentPeriodEnd, -2), only())).invoiced).toBe(0);
    const invs = await owner.saasInvoice.findMany({ where: { organizationId: A.id } });
    const plan = await owner.plan.findUniqueOrThrow({ where: { code: 'plataforma' } });
    expect(invs).toHaveLength(1);
    expect(invs[0]).toMatchObject({ status: 'pending', amountCop: plan.priceMonthlyCop, billingCycle: 'monthly' });
    expect(invs[0].periodStart.getTime()).toBe(sub.currentPeriodEnd.getTime());
  });

  it('al vencer entra en gracia y al acabar la gracia queda en solo lectura', async () => {
    const sub = await subOf(A.id);
    await saas.daily(addDays(sub.currentPeriodEnd, 1), only());
    const pd = await subOf(A.id);
    expect(pd.status).toBe('past_due');
    expect(pd.graceEndsAt!.getTime()).toBe(addDays(sub.currentPeriodEnd, 5).getTime());
    await http.post('/api/v1/subscribers').set(auth(A.token)).send({ code: 'G1', fullName: 'En gracia', documentNumber: '1001', address: 'Calle 1' }).expect(201);

    expect((await saas.daily(addDays(sub.currentPeriodEnd, 6), only())).suspended).toBe(2);
    expect((await subOf(A.id)).status).toBe('suspended');
    const blocked = await http.post('/api/v1/subscribers').set(auth(A.token)).send({ code: 'G2', fullName: 'Bloqueado', documentNumber: '1002', address: 'Calle 2' }).expect(403);
    expect(blocked.body.code).toBe('SUBSCRIPTION_READ_ONLY');
    // Consultar sigue funcionando y se puede ver la suscripción para pagar.
    await http.get('/api/v1/subscribers').set(auth(A.token)).expect(200);
    const ov = await http.get('/api/v1/subscription').set(auth(A.token)).expect(200);
    expect(ov.body).toMatchObject({ subscription: { status: 'suspended' }, payWith: { mercadoPago: true, transfer: true }, bank: { accountNumber: '123-456' } });
  });

  it('transferencia: comprobante en revisión, rechazo y aprobación que reactiva la cuenta', async () => {
    const inv = await owner.saasInvoice.findFirstOrThrow({ where: { organizationId: A.id, status: 'pending' } });
    await http.post(`/api/v1/subscription/invoices/${inv.id}/transfer`).set(auth(A.token))
      .field('reference', 'TRX-1').field('paidAt', '2026-12-10').attach('file', Buffer.from('no es imagen'), { filename: 'x.png', contentType: 'image/png' }).expect(400);
    const rep = await http.post(`/api/v1/subscription/invoices/${inv.id}/transfer`).set(auth(A.token))
      .field('reference', 'TRX-1').field('paidAt', '2026-12-10').attach('file', PNG, { filename: 'comprobante.png', contentType: 'image/png' }).expect(201);
    expect((await owner.saasInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('in_review');
    await http.post(`/api/v1/subscription/invoices/${inv.id}/transfer`).set(auth(A.token))
      .field('reference', 'TRX-2').field('paidAt', '2026-12-10').attach('file', PNG, { filename: 'c.png', contentType: 'image/png' }).expect(409);

    // B no ve el comprobante de A; el superadmin sí.
    await http.get(`/api/v1/subscription/payments/${rep.body.id}/proof`).set(auth(B.token)).expect(404);
    await http.get(`/api/v1/subscription/payments/${rep.body.id}/proof`).set(auth(A.token)).expect(200);
    const ov = await http.get('/api/v1/platform/saas').set(auth(admin)).expect(200);
    expect(ov.body.pendingTransfers.map((p: any) => p.id)).toContain(rep.body.id);
    expect(JSON.stringify(ov.body)).not.toContain('proofKey');
    await http.get(`/api/v1/platform/saas/payments/${rep.body.id}/proof`).set(auth(admin)).expect(200);
    await http.get('/api/v1/platform/saas').set(auth(A.token)).expect(403);

    await http.post(`/api/v1/platform/saas/payments/${rep.body.id}/review`).set(auth(admin)).send({ decision: 'reject', reason: 'El valor no coincide' }).expect(200);
    expect((await owner.saasInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');

    const again = await http.post(`/api/v1/subscription/invoices/${inv.id}/transfer`).set(auth(A.token))
      .field('reference', 'TRX-3').field('paidAt', '2026-12-11').attach('file', PNG, { filename: 'c.png', contentType: 'image/png' }).expect(201);
    await http.post(`/api/v1/platform/saas/payments/${again.body.id}/review`).set(auth(admin)).send({ decision: 'approve' }).expect(200);
    await http.post(`/api/v1/platform/saas/payments/${again.body.id}/review`).set(auth(admin)).send({ decision: 'approve' }).expect(409);

    const paid = await owner.saasInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(paid).toMatchObject({ status: 'paid', paymentMethod: 'transfer' });
    const sub = await subOf(A.id);
    expect(sub.status).toBe('active');
    expect(sub.graceEndsAt).toBeNull();
    // Estaba suspendida desde antes del fin del período facturado: el período nuevo arranca hoy.
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * 86_400_000);
    await http.post('/api/v1/subscribers').set(auth(A.token)).send({ code: 'G3', fullName: 'Reactivado', documentNumber: '1003', address: 'Calle 3' }).expect(201);
  });

  it('Mercado Pago: solo se da por pagado lo que su API confirma con monto y moneda correctos', async () => {
    const inv = await owner.saasInvoice.findFirstOrThrow({ where: { organizationId: B.id, status: 'pending' } });
    const start = await http.post(`/api/v1/subscription/invoices/${inv.id}/mercadopago`).set(auth(B.token)).expect(201);
    expect(start.body.url).toMatch(/^https:\/\/mp\.test\//);
    expect(mp.preferences.at(-1)).toMatchObject({ invoiceId: inv.id, amountCop: inv.amountCop });
    await http.post(`/api/v1/subscription/invoices/${inv.id}/mercadopago`).set(auth(A.token)).expect(404);

    mp.payments.set('9001', { id: '9001', status: 'approved', amount: inv.amountCop - 1, currency: 'COP', externalReference: inv.id });
    const short = await http.post(`/api/v1/subscription/invoices/${inv.id}/mercadopago/sync`).set(auth(B.token)).send({ paymentId: '9001' }).expect(200);
    expect(short.body).toMatchObject({ status: 'rejected', invoiceStatus: 'pending' });

    mp.payments.set('9002', { id: '9002', status: 'pending', amount: inv.amountCop, currency: 'COP', externalReference: inv.id });
    expect((await http.post(`/api/v1/subscription/invoices/${inv.id}/mercadopago/sync`).set(auth(B.token)).send({ paymentId: '9002' }).expect(200)).body.invoiceStatus).toBe('pending');

    // El pago 9002 se aprueba y llega por webhook (con firma).
    mp.payments.set('9002', { id: '9002', status: 'approved', amount: inv.amountCop, currency: 'COP', externalReference: inv.id, dateApproved: new Date().toISOString() });
    process.env.MP_WEBHOOK_SECRET = 'secreto-prueba';
    const ts = String(Math.floor(Date.now() / 1000));
    const sign = (id: string, reqId: string) => `ts=${ts},v1=${createHmac('sha256', 'secreto-prueba').update(`id:${id};request-id:${reqId};ts:${ts};`).digest('hex')}`;
    await http.post('/api/v1/public/payments/mercadopago/webhook?data.id=9002&type=payment').set('x-signature', 'ts=1,v1=' + 'a'.repeat(64)).set('x-request-id', 'r1').send({}).expect(200);
    expect((await owner.saasInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending'); // firma inválida: ignorado
    await http.post('/api/v1/public/payments/mercadopago/webhook?data.id=9002&type=payment').set('x-signature', sign('9002', 'r2')).set('x-request-id', 'r2').send({ type: 'payment', data: { id: '9002' } }).expect(200);
    await http.post('/api/v1/public/payments/mercadopago/webhook?data.id=9002&type=payment').set('x-signature', sign('9002', 'r3')).set('x-request-id', 'r3').send({}).expect(200);
    delete process.env.MP_WEBHOOK_SECRET;

    expect(await owner.saasInvoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ status: 'paid', paymentMethod: 'mercadopago' });
    expect(await owner.saasPayment.count({ where: { providerPaymentId: '9002' } })).toBe(1);
    expect((await subOf(B.id)).status).toBe('active');
    expect(await owner.auditLog.count({ where: { action: 'saas.invoice_paid', entityId: inv.id } })).toBe(1);

    // Un pago de otra factura no se acepta en esta.
    mp.payments.set('9003', { id: '9003', status: 'approved', amount: 1, currency: 'COP', externalReference: A.id });
    await http.post(`/api/v1/subscription/invoices/${inv.id}/mercadopago/sync`).set(auth(B.token)).send({ paymentId: '9003' }).expect(400);
  });

  it('superadmin: ajuste manual de la fecha de corte, pago manual y anulación', async () => {
    const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    await http.patch(`/api/v1/platform/saas/organizations/${A.id}/subscription`).set(auth(admin)).send({ currentPeriodEnd: '2020-01-01', reason: 'Fecha pasada' }).expect(400);
    await http.patch(`/api/v1/platform/saas/organizations/${A.id}/subscription`).set(auth(admin)).send({ currentPeriodEnd: future, billingCycle: 'yearly', reason: 'Cortesía por piloto' }).expect(200);
    const sub = await subOf(A.id);
    expect(sub).toMatchObject({ status: 'active', billingCycle: 'yearly' });
    expect(await owner.auditLog.count({ where: { action: 'saas.subscription_adjusted', organizationId: A.id } })).toBe(1);

    // La factura siguiente sale por el valor anual.
    expect((await saas.daily(addDays(sub.currentPeriodEnd, -1), { organizationIds: [A.id] })).invoiced).toBe(1);
    const inv = await owner.saasInvoice.findFirstOrThrow({ where: { organizationId: A.id, status: 'pending' } });
    const plan = await owner.plan.findUniqueOrThrow({ where: { code: 'plataforma' } });
    expect(inv).toMatchObject({ billingCycle: 'yearly', amountCop: plan.priceYearlyCop });

    await http.post(`/api/v1/platform/saas/invoices/${inv.id}/void`).set(auth(admin)).send({ reason: 'Error de prueba' }).expect(200);
    await http.post(`/api/v1/platform/saas/invoices/${inv.id}/manual-payment`).set(auth(admin)).send({ method: 'manual', reference: 'Efectivo' }).expect(409);
    await saas.daily(addDays(sub.currentPeriodEnd, -1), { organizationIds: [A.id] });
    const inv2 = await owner.saasInvoice.findFirstOrThrow({ where: { organizationId: A.id, status: 'pending' } });
    await http.post(`/api/v1/platform/saas/invoices/${inv2.id}/manual-payment`).set(auth(admin)).send({ method: 'manual', reference: 'Consignación oficina' }).expect(200);
    expect(await owner.saasInvoice.findUniqueOrThrow({ where: { id: inv2.id } })).toMatchObject({ status: 'paid', paymentMethod: 'manual' });
    expect((await subOf(A.id)).currentPeriodEnd.getTime()).toBe(inv2.periodEnd.getTime());
  });

  it('el plan y la configuración solo los cambia el superadmin', async () => {
    const plan = await owner.plan.findUniqueOrThrow({ where: { code: 'plataforma' } });
    await http.patch(`/api/v1/platform/saas/plans/${plan.id}`).set(auth(A.token)).send({ name: 'X', priceMonthlyCop: 1, priceYearlyCop: 1, trialDays: 1 }).expect(403);
    await http.patch(`/api/v1/platform/saas/plans/${plan.id}`).set(auth(admin))
      .send({ name: plan.name, priceMonthlyCop: plan.priceMonthlyCop, priceYearlyCop: plan.priceYearlyCop, trialDays: plan.trialDays }).expect(200);
    await http.put('/api/v1/platform/saas/settings').set(auth(B.token)).send({}).expect(403);
  });

  it('B no ve las facturas de A', async () => {
    const ov = await http.get('/api/v1/subscription').set(auth(B.token)).expect(200);
    expect(ov.body.invoices.every((i: any) => i.organizationId === B.id)).toBe(true);
  });
});
