/**
 * Sesiones con cookie httpOnly, protección CSRF, cierre de sesión y recuperación de contraseña.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';
import { MailMessage, MailService } from '../src/mail/mail.service';
import { sid } from './helpers';

const run = Date.now().toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const PW = 'Clave12345!';
const email = `as-owner-${run}@test.co`;

describe('Sesiones y recuperación de contraseña', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let orgId = '';
  const outbox: MailMessage[] = [];
  const cookieOf = (token: string) => `am_sid=${encodeURIComponent(token)}`;
  const lastLink = () => /\/recuperar\?token=([\w-]+)/.exec(outbox[outbox.length - 1]?.text ?? '')?.[1] ?? '';

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    app.get(MailService).useTransport({ name: 'test', send: async (_from, msg) => { outbox.push(msg); } });
    const nit = `7${run}4`;
    const reg = await http.post('/api/v1/onboarding/organizations').send({
      name: `Acueducto Sesiones ${run}`, legalName: `Asociación Sesiones ${run}`, nit, nitDv: nitCheckDigit(nit), department: 'Nariño',
      municipality: 'Pasto', organizationType: 'comunitario', estimatedSubscribers: 10, contactEmail: `as-c-${run}@test.co`, contactPhone: '3001234567',
      owner: { fullName: 'Dueña Sesiones', email, password: PW },
    }).expect(201);
    orgId = reg.body.organizationId;
  });

  afterAll(async () => {
    const users = await owner.membership.findMany({ where: { organizationId: orgId }, select: { userId: true } });
    await owner.organization.deleteMany({ where: { id: orgId } });
    await owner.user.deleteMany({ where: { id: { in: users.map((u) => u.userId) } } });
    await Promise.all([owner.$disconnect(), app?.close()]);
  });

  it('el login pone una cookie httpOnly y no devuelve el token en el cuerpo', async () => {
    const res = await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(201);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] as any).find((c) => c.startsWith('am_sid='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(res.body)).not.toContain(sid(res));
    expect(res.body.activeOrganizationId).toBe(orgId);
    const s = await owner.session.findFirstOrThrow({ where: { userId: res.body.user.id }, orderBy: { createdAt: 'desc' } });
    expect(s.tokenHash).not.toBe(sid(res)); // en la BD solo está el hash
  });

  it('con cookie, modificar datos exige el encabezado anti-CSRF', async () => {
    const token = sid(await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(201));
    await http.get('/api/v1/auth/session').set('Cookie', cookieOf(token)).expect(200);
    const sub = { code: 'C1', fullName: 'Suscriptor Cookie', documentNumber: '123', address: 'Calle 1' };
    await http.post('/api/v1/subscribers').set('Cookie', cookieOf(token)).send(sub).expect(403);
    await http.post('/api/v1/subscribers').set('Cookie', cookieOf(token)).set('X-Requested-With', 'aguamata').send(sub).expect(201);
    await owner.subscriber.deleteMany({ where: { organizationId: orgId } });
  });

  it('salir revoca la sesión en el servidor', async () => {
    const token = sid(await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(201));
    await http.post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`).expect(204);
    await http.get('/api/v1/auth/session').set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('una sesión vencida no sirve', async () => {
    const token = sid(await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(201));
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    await owner.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http.get('/api/v1/auth/session').set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('cambiar la contraseña cierra las demás sesiones pero no la actual', async () => {
    const a = sid(await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(201));
    const b = sid(await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(201));
    await http.patch('/api/v1/auth/password').set('Authorization', `Bearer ${a}`).send({ currentPassword: PW, newPassword: 'Temporal2026!' }).expect(200);
    await http.get('/api/v1/auth/session').set('Authorization', `Bearer ${a}`).expect(200);
    await http.get('/api/v1/auth/session').set('Authorization', `Bearer ${b}`).expect(401);
    await http.patch('/api/v1/auth/password').set('Authorization', `Bearer ${a}`).send({ currentPassword: 'Temporal2026!', newPassword: PW }).expect(200);
  });

  it('pedir recuperación responde igual exista o no el correo', async () => {
    const before = outbox.length;
    const res = await http.post('/api/v1/auth/password-reset').send({ email: `nadie-${run}@test.co` }).expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(outbox.length).toBe(before);
  });

  it('recuperar la contraseña: enlace de un solo uso que cierra todas las sesiones', async () => {
    const session = sid(await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(201));
    await http.post('/api/v1/auth/password-reset').send({ email: email.toUpperCase(), organizationId: orgId }).expect(200);
    const token = lastLink();
    expect(token).not.toBe('');
    // Pedido desde la dirección del acueducto: el enlace apunta a su subdominio.
    expect(outbox[outbox.length - 1].text).toMatch(/acueducto-sesiones/);

    expect((await http.get(`/api/v1/auth/password-reset/${token}`).expect(200)).body.email).toBe(email);
    await http.post(`/api/v1/auth/password-reset/${token}`).send({ password: 'corta' }).expect(400);
    await http.post(`/api/v1/auth/password-reset/${token}`).send({ password: 'Recuperada2026' }).expect(200);

    await http.get('/api/v1/auth/session').set('Authorization', `Bearer ${session}`).expect(401);
    await http.post(`/api/v1/auth/password-reset/${token}`).send({ password: 'OtraVez2026!' }).expect(400);
    await http.post('/api/v1/auth/login').send({ email, password: PW }).expect(401);
    await http.post('/api/v1/auth/login').send({ email, password: 'Recuperada2026' }).expect(201);
  });

  it('un enlace vencido no sirve y hay un máximo de enlaces por hora', async () => {
    await http.post('/api/v1/auth/password-reset').send({ email }).expect(200);
    const token = lastLink();
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    await owner.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http.get(`/api/v1/auth/password-reset/${token}`).expect(400);

    const before = outbox.length;
    for (let i = 0; i < 4; i++) await http.post('/api/v1/auth/password-reset').send({ email }).expect(200);
    expect(outbox.length - before).toBeLessThanOrEqual(1); // ya había 2 en la última hora; el límite es 3
  });
});
