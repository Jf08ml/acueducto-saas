/**
 * Personal del acueducto: invitaciones, roles, desactivación y aislamiento.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';

const run = (Date.now() + 5).toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const PW = 'Clave12345!';
const mail = (tag: string) => `team-${tag}-${run}@test.co`;

describe('Personal del acueducto', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const A = { id: '', token: '' };
  const B = { id: '', token: '' };
  const tokens: Record<string, string> = {};
  const memberId: Record<string, string> = {};

  async function register(tag: string, suffix: string) {
    const nit = `4${run}${suffix}`;
    const reg = await http.post('/api/v1/onboarding/organizations').send({
      name: `Acueducto Team ${tag} ${run}`, legalName: `Asociación Team ${tag}`, nit, nitDv: nitCheckDigit(nit),
      department: 'Meta', municipality: 'Granada', organizationType: 'comunitario', estimatedSubscribers: 10,
      contactEmail: mail(`c${tag}`), contactPhone: '3001234567', owner: { fullName: `Dueño ${tag}`, email: mail(`owner${tag}`), password: PW },
    }).expect(201);
    return { id: reg.body.organizationId as string, token: await login(mail(`owner${tag}`)) };
  }
  async function login(email: string, password = PW, organizationId?: string) {
    return (await http.post('/api/v1/auth/login').send({ email, password, organizationId }).expect(201)).body.accessToken as string;
  }
  const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
  const invite = (t: string, email: string, role: string) => http.post('/api/v1/team/invitations').set(auth(t)).send({ email, role });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    Object.assign(A, await register('A', '1'));
    Object.assign(B, await register('B', '2'));
  });

  afterAll(async () => {
    const ids = [A.id, B.id].filter(Boolean);
    const users = await owner.membership.findMany({ where: { organizationId: { in: ids } }, select: { userId: true } });
    await owner.subscriber.deleteMany({ where: { organizationId: { in: ids } } });
    await owner.organization.deleteMany({ where: { id: { in: ids } } });
    await owner.user.deleteMany({ where: { id: { in: users.map((u) => u.userId) } } });
    await owner.$disconnect();
    await app?.close();
  });

  it('el dueño invita a un administrador y recibe un enlace del subdominio del acueducto', async () => {
    const res = await invite(A.token, `  ${mail('admin').toUpperCase()} `, 'admin').expect(201);
    expect(res.body.email).toBe(mail('admin'));
    expect(res.body.inviteUrl).toMatch(/^http:\/\/[a-z0-9-]+\.localhost:3000\/invitacion\?token=/);
    expect(res.body.emailSent).toBe(false);
    tokens.admin = tokenOf(res.body.inviteUrl);
    await invite(A.token, mail('admin'), 'operator').expect(409); // ya hay una pendiente
  });

  it('la invitación muestra datos públicos y se acepta una sola vez', async () => {
    const d = await http.get(`/api/v1/public/invitations/${tokens.admin}`).expect(200);
    expect(d.body).toMatchObject({ email: mail('admin'), role: 'admin', userExists: false, organization: { id: A.id } });
    await http.post(`/api/v1/public/invitations/${tokens.admin}/accept`).send({ password: PW }).expect(400); // falta el nombre
    expect(await owner.invitation.count({ where: { organizationId: A.id, acceptedAt: { not: null } } })).toBe(0); // rollback
    await http.post(`/api/v1/public/invitations/${tokens.admin}/accept`).send({ fullName: 'Ana Admin', password: PW }).expect(201);
    await http.post(`/api/v1/public/invitations/${tokens.admin}/accept`).send({ fullName: 'Ana Admin', password: PW }).expect(400);
    tokens.adminSession = await login(mail('admin'));
  });

  it('el administrador no puede invitar dueños; sí operadores', async () => {
    await invite(tokens.adminSession, mail('x'), 'owner').expect(403);
    const res = await invite(tokens.adminSession, mail('op'), 'operator').expect(201);
    await http.post(`/api/v1/public/invitations/${tokenOf(res.body.inviteUrl)}/accept`).send({ fullName: 'Oscar Operador', password: PW }).expect(201);
    tokens.op = await login(mail('op'));
    const list = await http.get('/api/v1/team').set(auth(A.token)).expect(200);
    for (const m of list.body.members) memberId[m.user.email.split('-')[1]] = m.id;
    expect(list.body.members.map((m: any) => m.role)).toEqual(['owner', 'admin', 'operator']);
  });

  it('cada rol solo hace lo que le corresponde', async () => {
    await http.get('/api/v1/team').set(auth(tokens.op)).expect(403);
    await http.post('/api/v1/subscribers').set(auth(tokens.op)).send({ code: 'OP1', fullName: 'Creado por operador', documentNumber: '123', address: 'Calle 1' }).expect(201);
    await http.post('/api/v1/billing/issue').set(auth(tokens.op)).send({ period: '2026-01', options: { missingReadings: 'block', unmeteredConsumptionM3: null }, issueDate: '2026-01-31', dueDate: '2026-02-15' }).expect(403);
  });

  it('nadie cambia su propio acceso y un administrador no toca a un dueño', async () => {
    await http.patch(`/api/v1/team/members/${memberId.admin}`).set(auth(tokens.adminSession)).send({ role: 'owner' }).expect(403);
    await http.patch(`/api/v1/team/members/${memberId.ownera}`).set(auth(tokens.adminSession)).send({ status: 'disabled' }).expect(403);
    await http.patch(`/api/v1/team/members/${memberId.ownera}`).set(auth(A.token)).send({ role: 'admin' }).expect(403);
  });

  it('desactivar un acceso lo corta de inmediato, incluso con un token ya emitido', async () => {
    await http.patch(`/api/v1/team/members/${memberId.op}`).set(auth(tokens.adminSession)).send({ status: 'disabled' }).expect(200);
    await http.get('/api/v1/subscribers').set(auth(tokens.op)).expect(403);
    await http.post('/api/v1/auth/login').send({ email: mail('op'), password: PW, organizationId: A.id }).expect(401);
    const noOrg = await http.post('/api/v1/auth/login').send({ email: mail('op'), password: PW }).expect(201);
    expect(noOrg.body.activeOrganizationId).toBeNull();
    await http.patch(`/api/v1/team/members/${memberId.op}`).set(auth(tokens.adminSession)).send({ status: 'active' }).expect(200);
    await http.get('/api/v1/subscribers').set(auth(tokens.op)).expect(200);
  });

  it('una persona con cuenta en otro acueducto acepta con su contraseña y puede cambiar de acueducto', async () => {
    const res = await invite(A.token, mail('ownerB'), 'reader').expect(201);
    const t = tokenOf(res.body.inviteUrl);
    expect((await http.get(`/api/v1/public/invitations/${t}`).expect(200)).body.userExists).toBe(true);
    await http.post(`/api/v1/public/invitations/${t}/accept`).send({ password: 'Equivocada123' }).expect(400);
    await http.post(`/api/v1/public/invitations/${t}/accept`).send({ password: PW }).expect(201);

    const orgs = await http.get('/api/v1/auth/organizations').set(auth(B.token)).expect(200);
    expect(orgs.body.map((o: any) => o.id).sort()).toEqual([A.id, B.id].sort());
    const sw = await http.post('/api/v1/auth/switch').set(auth(B.token)).send({ organizationId: A.id }).expect(201);
    const asReader = sw.body.accessToken;
    expect((await http.get('/api/v1/me/organization').set(auth(asReader)).expect(200)).body).toMatchObject({ organization: { id: A.id }, role: 'reader' });
    await http.post('/api/v1/subscribers').set(auth(asReader)).send({ code: 'R1', fullName: 'Lector intenta', documentNumber: '1', address: 'Calle 1' }).expect(403);
    await http.post('/api/v1/auth/switch').set(auth(tokens.op)).send({ organizationId: B.id }).expect(403);
  });

  it('el límite de usuarios del plan cuenta personal activo e invitaciones vigentes', async () => {
    const seats = await owner.membership.count({ where: { organizationId: A.id, status: 'active' } });
    await owner.orgEntitlementOverride.create({ data: { organizationId: A.id, key: 'limit:max_admin_users', value: seats } });
    const res = await invite(A.token, mail('extra'), 'reader').expect(403);
    expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
    await owner.orgEntitlementOverride.deleteMany({ where: { organizationId: A.id } });
  });

  it('reenviar invalida el enlace anterior; cancelar y vencer lo inutilizan', async () => {
    const first = await invite(A.token, mail('late'), 'reader').expect(201);
    const old = tokenOf(first.body.inviteUrl);
    const again = await http.post(`/api/v1/team/invitations/${first.body.id}/resend`).set(auth(A.token)).expect(201);
    await http.get(`/api/v1/public/invitations/${old}`).expect(404);
    const fresh = tokenOf(again.body.inviteUrl);
    await http.get(`/api/v1/public/invitations/${fresh}`).expect(200);

    await owner.invitation.update({ where: { id: first.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http.get(`/api/v1/public/invitations/${fresh}`).expect(400);
    await http.delete(`/api/v1/team/invitations/${first.body.id}`).set(auth(A.token)).expect(204);
    await http.get(`/api/v1/public/invitations/${fresh}`).expect(404);
  });

  it('B no ve ni gestiona personal o invitaciones de A', async () => {
    const pending = await invite(A.token, mail('pend'), 'reader').expect(201);
    const listB = await http.get('/api/v1/team').set(auth(B.token)).expect(200);
    expect(listB.body.members.map((m: any) => m.user.email)).toEqual([mail('ownerB').toLowerCase()]);
    expect(listB.body.invitations).toEqual([]);
    await http.patch(`/api/v1/team/members/${memberId.op}`).set(auth(B.token)).send({ status: 'disabled' }).expect(404);
    await http.delete(`/api/v1/team/members/${memberId.op}`).set(auth(B.token)).expect(404);
    await http.delete(`/api/v1/team/invitations/${pending.body.id}`).set(auth(B.token)).expect(404);
  });

  it('quitar a un miembro le retira el acceso', async () => {
    await http.delete(`/api/v1/team/members/${memberId.op}`).set(auth(A.token)).expect(204);
    await http.get('/api/v1/subscribers').set(auth(tokens.op)).expect(403);
  });

  it('cambio de contraseña', async () => {
    await http.patch('/api/v1/auth/password').set(auth(tokens.adminSession)).send({ currentPassword: 'mala', newPassword: 'NuevaClave2026' }).expect(400);
    await http.patch('/api/v1/auth/password').set(auth(tokens.adminSession)).send({ currentPassword: PW, newPassword: 'NuevaClave2026' }).expect(200);
    await http.post('/api/v1/auth/login').send({ email: mail('admin'), password: PW }).expect(401);
    await login(mail('admin'), 'NuevaClave2026');
  });
});
