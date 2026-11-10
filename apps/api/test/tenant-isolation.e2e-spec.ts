/**
 * PRUEBA DE AISLAMIENTO ENTRE TENANTS — obligatoria en CI.
 * Crea dos acueductos reales y verifica que ninguno ve ni modifica datos del otro,
 * ni por la API ni por la base de datos directamente, y que el superadmin no ve datos privados.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';
import { sid } from './helpers';

const run = Date.now().toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL }); // limpieza y verificación
const appRole = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL }); // mismo rol que la API

function orgPayload(tag: string, nit: string) {
  return {
    name: `Acueducto ${tag} ${run}`,
    legalName: `Asociación de Usuarios ${tag} ${run}`,
    nit,
    nitDv: nitCheckDigit(nit),
    department: 'Nariño',
    municipality: 'Pasto',
    organizationType: 'asociacion_usuarios',
    estimatedSubscribers: 120,
    contactEmail: `contacto-${tag}-${run}@test.co`,
    contactPhone: '3001234567',
    owner: { fullName: `Dueño ${tag}`, email: `owner-${tag}-${run}@test.co`, password: 'Clave12345!' },
  };
}

describe('Aislamiento entre tenants', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const A = { id: '', token: '', subscriberId: '' };
  const B = { id: '', token: '', subscriberId: '' };
  let adminToken = '';

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());

    for (const [org, tag, nit] of [[A, 'a', `9${run}1`], [B, 'b', `9${run}2`]] as const) {
      const p = orgPayload(tag, nit);
      const reg = await http.post('/api/v1/onboarding/organizations').send(p).expect(201);
      org.id = reg.body.organizationId;
      const login = await http.post('/api/v1/auth/login').send({ email: p.owner.email, password: p.owner.password }).expect(201);
      org.token = sid(login);
      const sub = await http
        .post('/api/v1/subscribers')
        .set('Authorization', `Bearer ${org.token}`)
        .send({ code: '001', fullName: `Suscriptor de ${tag}`, documentNumber: `10${run}`, address: 'Vereda El Encano' })
        .expect(201);
      org.subscriberId = sub.body.id;
    }

    const admin = await http
      .post('/api/v1/auth/login')
      .send({ email: process.env.SUPERADMIN_EMAIL ?? 'admin@aguamata.local', password: process.env.SUPERADMIN_PASSWORD ?? 'Admin12345!' })
      .expect(201);
    adminToken = sid(admin);
  });

  afterAll(async () => {
    const ids = [A.id, B.id].filter(Boolean);
    await owner.subscriber.deleteMany({ where: { organizationId: { in: ids } } });
    const users = await owner.membership.findMany({ where: { organizationId: { in: ids } }, select: { userId: true } });
    await owner.organization.deleteMany({ where: { id: { in: ids } } });
    await owner.user.deleteMany({ where: { id: { in: users.map((u) => u.userId) } } });
    await Promise.all([owner.$disconnect(), appRole.$disconnect(), app?.close()]);
  });

  it('cada acueducto lista solo sus suscriptores (mismo código "001" en ambos)', async () => {
    const resA = await http.get('/api/v1/subscribers').set('Authorization', `Bearer ${A.token}`).expect(200);
    expect(resA.body.map((s: any) => s.id)).toEqual([A.subscriberId]);
    const resB = await http.get('/api/v1/subscribers').set('Authorization', `Bearer ${B.token}`).expect(200);
    expect(resB.body.map((s: any) => s.id)).toEqual([B.subscriberId]);
  });

  it('A no puede leer un suscriptor de B aunque conozca su id', async () => {
    await http.get(`/api/v1/subscribers/${B.subscriberId}`).set('Authorization', `Bearer ${A.token}`).expect(404);
  });

  it('A no puede elegir la organización de B al iniciar sesión', async () => {
    await http
      .post('/api/v1/auth/login')
      .send({ email: `owner-a-${run}@test.co`, password: 'Clave12345!', organizationId: B.id })
      .expect(401);
  });

  it('organization_id del cuerpo se ignora: no se puede crear en otro tenant', async () => {
    const res = await http
      .post('/api/v1/subscribers')
      .set('Authorization', `Bearer ${A.token}`)
      .send({ code: '002', fullName: 'Intruso', documentNumber: '999', address: 'Calle 1', organizationId: B.id })
      .expect(201);
    expect(res.body.organizationId).toBe(A.id);
  });

  it('el superadmin NO accede a datos de acueductos', async () => {
    await http.get('/api/v1/subscribers').set('Authorization', `Bearer ${adminToken}`).expect(403);
  });

  it('el superadmin ve solo métricas agregadas (conteo de suscriptores)', async () => {
    const res = await http.get('/api/v1/platform/organizations').set('Authorization', `Bearer ${adminToken}`).expect(200);
    const a = res.body.find((o: any) => o.id === A.id);
    expect(a.subscriberCount).toBe(2);
    expect(a).not.toHaveProperty('subscribers');
  });

  it('un dueño de acueducto no entra al panel superadmin', async () => {
    await http.get('/api/v1/platform/organizations').set('Authorization', `Bearer ${A.token}`).expect(403);
  });

  it('organización suspendida pierde acceso a sus datos', async () => {
    await http.patch(`/api/v1/platform/organizations/${B.id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'suspended', reason: 'prueba' }).expect(200);
    await http.get('/api/v1/subscribers').set('Authorization', `Bearer ${B.token}`).expect(403);
    await http.patch(`/api/v1/platform/organizations/${B.id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'active', reason: 'prueba' }).expect(200);
  });

  describe('a nivel de base de datos (rol de la app, sin pasar por la API)', () => {
    it('sin contexto de tenant, RLS devuelve 0 filas', async () => {
      const rows = await appRole.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM tenant.subscribers`;
      expect(Number(rows[0].n)).toBe(0);
    });

    it('con contexto de A, solo se ven filas de A', async () => {
      const [, rows] = await appRole.$transaction([
        appRole.$executeRaw`SELECT set_config('app.current_org', ${A.id}, TRUE)`,
        appRole.$queryRaw<{ organization_id: string }[]>`SELECT organization_id::text FROM tenant.subscribers`,
      ]);
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.organization_id === A.id)).toBe(true);
    });

    it('con contexto de A, insertar una fila de B es rechazado por WITH CHECK', async () => {
      await expect(
        appRole.$transaction([
          appRole.$executeRaw`SELECT set_config('app.current_org', ${A.id}, TRUE)`,
          appRole.$executeRaw`INSERT INTO tenant.subscribers (id, organization_id, code, full_name, document_number, address, updated_at)
                              VALUES (gen_random_uuid(), ${B.id}::uuid, 'X1', 'x', 'x', 'x', now())`,
        ]),
      ).rejects.toThrow(/row-level security/);
    });

    it('TODA tabla del esquema tenant tiene RLS forzado y política de aislamiento', async () => {
      const unprotected = await owner.$queryRaw<{ table: string }[]>`
        SELECT c.relname AS table
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'tenant' AND c.relkind = 'r'
          AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
               OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'))`;
      expect(unprotected).toEqual([]);
    });

    it('la bitácora de auditoría es append-only para la app', async () => {
      await expect(appRole.$executeRaw`DELETE FROM platform.audit_logs`).rejects.toThrow(/permission denied/);
    });
  });
});
