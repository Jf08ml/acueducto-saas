/**
 * Acceso temporal de soporte y auditoría: el superadmin solo ve datos de un acueducto si este lo aprueba,
 * por el tiempo y con el alcance aprobados; cada petición queda en la bitácora y el acueducto puede revocarlo.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';
import { sid } from './helpers';

const run = Date.now().toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const PW = 'Clave12345!';

describe('Acceso de soporte y auditoría', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const A = { id: '', token: '' };
  const B = { id: '', token: '' };
  let admin = '';
  const adminLogin = async () => sid(await http.post('/api/v1/auth/login')
    .send({ email: process.env.SUPERADMIN_EMAIL ?? 'admin@aguamata.local', password: process.env.SUPERADMIN_PASSWORD ?? 'Admin12345!' }).expect(201));

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    for (const [o, tag, nit] of [[A, 'A', `5${run}1`], [B, 'B', `5${run}2`]] as const) {
      const email = `sup-${tag}-${run}@test.co`;
      const reg = await http.post('/api/v1/onboarding/organizations').send({
        name: `Acueducto Soporte ${tag} ${run}`, legalName: `Asociación Soporte ${tag}`, nit, nitDv: nitCheckDigit(nit), department: 'Nariño',
        municipality: 'Pasto', organizationType: 'comunitario', estimatedSubscribers: 10, contactEmail: `c-${email}`, contactPhone: '3001234567',
        owner: { fullName: `Dueño ${tag}`, email, password: PW },
      }).expect(201);
      o.id = reg.body.organizationId;
      o.token = sid(await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(201));
    }
    await http.post('/api/v1/subscribers').set(auth(A.token)).send({ code: 'S1', fullName: 'Suscriptor Privado', documentNumber: '5550001', address: 'Vereda 1' }).expect(201);
    admin = await adminLogin();
  });

  afterAll(async () => {
    const ids = [A.id, B.id].filter(Boolean);
    const users = await owner.membership.findMany({ where: { organizationId: { in: ids } }, select: { userId: true } });
    await owner.session.deleteMany({ where: { organizationId: { in: ids } } });
    await owner.subscriber.deleteMany({ where: { organizationId: { in: ids } } });
    await owner.organization.deleteMany({ where: { id: { in: ids } } });
    await owner.user.deleteMany({ where: { id: { in: users.map((u) => u.userId) } } });
    await Promise.all([owner.$disconnect(), app?.close()]);
  });

  it('sin permiso, el superadmin no ve datos del acueducto', async () => {
    await http.get('/api/v1/subscribers').set(auth(admin)).expect(403);
  });

  let grantId = '';
  it('pedir acceso: queda pendiente y el acueducto lo ve; no se puede pedir dos veces', async () => {
    await http.post(`/api/v1/platform/support/organizations/${A.id}/grants`).set(auth(A.token)).send({ reason: 'Revisar un error al facturar', scope: 'read', durationHours: 2 }).expect(403);
    const g = await http.post(`/api/v1/platform/support/organizations/${A.id}/grants`).set(auth(admin)).send({ reason: 'Revisar un error al facturar', scope: 'read', durationHours: 2 }).expect(201);
    grantId = g.body.id;
    expect(g.body).toMatchObject({ status: 'pending', scope: 'read', durationHours: 2 });
    await http.post(`/api/v1/platform/support/organizations/${A.id}/grants`).set(auth(admin)).send({ reason: 'Otra solicitud cualquiera', scope: 'read', durationHours: 1 }).expect(409);
    const list = await http.get('/api/v1/support/grants').set(auth(A.token)).expect(200);
    expect(list.body.map((x: any) => x.id)).toEqual([grantId]);
    expect((await http.get('/api/v1/support/grants').set(auth(B.token)).expect(200)).body).toEqual([]);
  });

  it('no se puede entrar antes de que el acueducto apruebe, y B no puede aprobar por A', async () => {
    await http.post(`/api/v1/platform/support/grants/${grantId}/enter`).set(auth(admin)).expect(400);
    await http.post(`/api/v1/support/grants/${grantId}/decision`).set(auth(B.token)).send({ decision: 'approve' }).expect(404);
  });

  let supportSession = '';
  it('aprobado: el soporte entra con una sesión que vence con el permiso y solo puede consultar', async () => {
    const ok = await http.post(`/api/v1/support/grants/${grantId}/decision`).set(auth(A.token)).send({ decision: 'approve' }).expect(200);
    const exp = new Date(ok.body.expiresAt).getTime();
    expect(exp).toBeGreaterThan(Date.now() + 1.9 * 3_600_000);
    expect(exp).toBeLessThan(Date.now() + 2.1 * 3_600_000);

    const enter = await http.post(`/api/v1/platform/support/grants/${grantId}/enter`).set(auth(admin)).expect(200);
    supportSession = sid(enter);
    await http.get('/api/v1/auth/session').set(auth(admin)).expect(401); // la sesión anterior del superadmin se cerró
    const s = await owner.session.findFirstOrThrow({ where: { supportGrantId: grantId } });
    expect(Math.abs(s.expiresAt.getTime() - exp)).toBeLessThan(5_000);

    const subs = await http.get('/api/v1/subscribers').set(auth(supportSession)).expect(200);
    expect(subs.body.map((x: any) => x.code)).toEqual(['S1']);
    const me = await http.get('/api/v1/me/organization').set(auth(supportSession)).expect(200);
    expect(me.body).toMatchObject({ organization: { id: A.id }, role: 'admin', membershipId: null, support: { id: grantId, scope: 'read' } });
    await http.post('/api/v1/subscribers').set(auth(supportSession)).send({ code: 'S2', fullName: 'No debe crearse', documentNumber: '5550002', address: 'Vereda 2' }).expect(403);
    await http.post(`/api/v1/support/grants/${grantId}/decision`).set(auth(supportSession)).send({ decision: 'approve' }).expect(403);
    await http.post('/api/v1/auth/switch').set(auth(supportSession)).send({ organizationId: B.id }).expect(403);
  });

  it('cada petición de soporte queda en la auditoría del acueducto (sin parámetros de búsqueda)', async () => {
    await http.get('/api/v1/subscribers?q=Privado').set(auth(supportSession)).expect(200);
    const log = await http.get('/api/v1/audit?category=support').set(auth(A.token)).expect(200);
    const reqs = log.body.items.filter((i: any) => i.action === 'support.request');
    expect(reqs.length).toBeGreaterThanOrEqual(3);
    expect(reqs.map((r: any) => r.data.path)).toContain('/api/v1/subscribers');
    expect(JSON.stringify(reqs)).not.toContain('Privado');
    expect(reqs[0].actor.isSupport).toBe(true);
    expect(log.body.items.map((i: any) => i.action)).toEqual(expect.arrayContaining(['support.requested', 'support.approved', 'support.session_started']));
    // B no ve nada de esto.
    expect((await http.get('/api/v1/audit?category=support').set(auth(B.token)).expect(200)).body.items).toEqual([]);
  });

  it('el acueducto revoca el acceso y la sesión de soporte deja de servir de inmediato', async () => {
    await http.post(`/api/v1/support/grants/${grantId}/revoke`).set(auth(A.token)).expect(200);
    await http.get('/api/v1/subscribers').set(auth(supportSession)).expect(401);
  });

  it('con alcance de modificación, lo que hace el soporte queda marcado; al vencer, se corta', async () => {
    admin = await adminLogin();
    const g = await http.post(`/api/v1/platform/support/organizations/${A.id}/grants`).set(auth(admin)).send({ reason: 'Corregir la tarifa mal cargada', scope: 'write', durationHours: 1 }).expect(201);
    await http.post(`/api/v1/support/grants/${g.body.id}/decision`).set(auth(A.token)).send({ decision: 'approve', note: 'Adelante' }).expect(200);
    const s = sid(await http.post(`/api/v1/platform/support/grants/${g.body.id}/enter`).set(auth(admin)).expect(200));
    const sub = await http.post('/api/v1/subscribers').set(auth(s)).send({ code: 'S3', fullName: 'Creado por soporte', documentNumber: '5550003', address: 'Vereda 3' }).expect(201);
    const entry = await owner.auditLog.findFirstOrThrow({ where: { action: 'subscriber.created', entityId: sub.body.id } });
    expect((entry.data as any).viaSupportGrant).toBe(g.body.id);

    await owner.supportAccessGrant.update({ where: { id: g.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await http.get('/api/v1/subscribers').set(auth(s)).expect(403);
    expect(res.body.code).toBe('SUPPORT_ACCESS_ENDED');
  });

  it('rechazar una solicitud', async () => {
    admin = await adminLogin();
    const g = await http.post(`/api/v1/platform/support/organizations/${B.id}/grants`).set(auth(admin)).send({ reason: 'Revisión general de la cuenta', scope: 'read', durationHours: 4 }).expect(201);
    await http.post(`/api/v1/support/grants/${g.body.id}/decision`).set(auth(B.token)).send({ decision: 'reject' }).expect(400); // falta la nota
    await http.post(`/api/v1/support/grants/${g.body.id}/decision`).set(auth(B.token)).send({ decision: 'reject', note: 'No es necesario' }).expect(200);
    await http.post(`/api/v1/platform/support/grants/${g.body.id}/enter`).set(auth(admin)).expect(400);
  });

  it('la auditoría del superadmin muestra soporte y cobro, pero no la operación del acueducto', async () => {
    const log = await http.get(`/api/v1/platform/audit?organizationId=${A.id}&limit=200`).set(auth(admin)).expect(200);
    const actions = log.body.items.map((i: any) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['support.requested', 'support.approved']));
    expect(actions).not.toContain('subscriber.created');
    await http.get('/api/v1/platform/audit').set(auth(A.token)).expect(403);
    await http.get('/api/v1/audit').set(auth(admin)).expect(403);
  });
});
