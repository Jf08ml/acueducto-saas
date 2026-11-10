/**
 * Dominios por acueducto (subdominio por defecto + dominio propio verificado) y medidores/lecturas.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';
import { sid } from './helpers';
import { DnsResolver } from '../src/domains/domains.module';

const run = (Date.now() + 2).toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const appRole = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

describe('Dominios, medidores y lecturas', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const orgs = {
    A: { id: '', slug: '', token: '', subscriberId: '', meterId: '' },
    B: { id: '', slug: '', token: '', subscriberId: '', meterId: '' },
  };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const customHost = `portal-a-${run}.example.org`;
  let domainId = '';
  const realResolver = DnsResolver.resolveTxt;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    for (const [tag, suffix] of [['A', '5'], ['B', '6']] as const) {
      const nit = `7${run}${suffix}`;
      const email = `dm-${tag}-${run}@test.co`;
      const reg = await http.post('/api/v1/onboarding/organizations').send({
        name: `Acueducto DM ${tag} ${run}`, legalName: `Asociación DM ${tag}`, nit, nitDv: nitCheckDigit(nit),
        department: 'Cauca', municipality: 'Popayán', organizationType: 'comunitario', estimatedSubscribers: 50,
        contactEmail: email, contactPhone: '3001234567', owner: { fullName: `Dueño ${tag}`, email, password: 'Clave12345!' },
      }).expect(201);
      const o = orgs[tag];
      o.id = reg.body.organizationId;
      o.slug = reg.body.slug;
      expect(reg.body.defaultUrl).toBe(`http://${o.slug}.localhost:3000`);
      o.token = sid(await http.post('/api/v1/auth/login').send({ email, password: 'Clave12345!' }).expect(201));
      o.subscriberId = (await http.post('/api/v1/subscribers').set(auth(o.token))
        .send({ code: '001', fullName: `Usuario ${tag}`, documentNumber: '123', address: 'Vereda 1' }).expect(201)).body.id;
      o.meterId = (await http.post('/api/v1/meters').set(auth(o.token))
        .send({ subscriberId: o.subscriberId, serial: `SER-${tag}-${run}`, installedAt: '2025-12-01', initialReading: 100 }).expect(201)).body.id;
    }
  });

  afterAll(async () => {
    DnsResolver.resolveTxt = realResolver;
    const ids = [orgs.A.id, orgs.B.id].filter(Boolean);
    const where = { organizationId: { in: ids } };
    await owner.meterReading.deleteMany({ where });
    await owner.meter.deleteMany({ where });
    await owner.subscriber.deleteMany({ where });
    const users = await owner.membership.findMany({ where, select: { userId: true } });
    await owner.organization.deleteMany({ where: { id: { in: ids } } });
    await owner.user.deleteMany({ where: { id: { in: users.map((u) => u.userId) } } });
    await Promise.all([owner.$disconnect(), appRole.$disconnect(), app?.close()]);
  });

  describe('dominios', () => {
    it('el subdominio por defecto resuelve al acueducto con solo datos públicos', async () => {
      const res = await http.get(`/api/v1/public/resolve-host?host=${orgs.A.slug}.localhost:3000`).expect(200);
      expect(res.body.kind).toBe('subdomain');
      expect(res.body.organization.id).toBe(orgs.A.id);
      expect(res.body.organization).not.toHaveProperty('nit');
      expect(res.body.organization).not.toHaveProperty('contactEmail');
      expect((await http.get('/api/v1/public/resolve-host?host=localhost:3000').expect(200)).body.kind).toBe('platform');
      await http.get(`/api/v1/public/resolve-host?host=no-existe-${run}.localhost`).expect(404);
    });

    it('no se puede registrar un subdominio de la plataforma como dominio propio', async () => {
      await http.post('/api/v1/domains').set(auth(orgs.A.token)).send({ hostname: `otro.localhost` }).expect(400);
    });

    it('un dominio propio no funciona hasta verificarse por DNS', async () => {
      const add = await http.post('/api/v1/domains').set(auth(orgs.A.token)).send({ hostname: `https://${customHost.toUpperCase()}/` }).expect(201);
      domainId = add.body.id;
      expect(add.body.hostname).toBe(customHost);
      expect(add.body.dns.map((r: any) => r.type)).toEqual(['TXT', 'CNAME']);
      await http.get(`/api/v1/public/resolve-host?host=${customHost}`).expect(404);
      await http.get(`/api/v1/public/tls-ask?domain=${customHost}`).expect(404);

      DnsResolver.resolveTxt = async () => [['otro-valor']];
      const bad = await http.post(`/api/v1/domains/${domainId}/verify`).set(auth(orgs.A.token)).expect(201);
      expect(bad.body.status).toBe('failed');

      const token = add.body.dns[0].value;
      DnsResolver.resolveTxt = async (name) => (name === `_aguamata-verify.${customHost}` ? [[token]] : []);
      const ok = await http.post(`/api/v1/domains/${domainId}/verify`).set(auth(orgs.A.token)).expect(201);
      expect(ok.body.status).toBe('verified');

      const res = await http.get(`/api/v1/public/resolve-host?host=${customHost}`).expect(200);
      expect(res.body).toMatchObject({ kind: 'custom', organization: { id: orgs.A.id } });
      await http.get(`/api/v1/public/tls-ask?domain=${customHost}`).expect(200);
    });

    it('CORS acepta el dominio verificado y los subdominios, rechaza orígenes desconocidos', async () => {
      const ok = await http.get('/api/v1/health').set('Origin', `https://${customHost}`);
      expect(ok.headers['access-control-allow-origin']).toBe(`https://${customHost}`);
      const sub = await http.get('/api/v1/health').set('Origin', `http://${orgs.B.slug}.localhost:3000`);
      expect(sub.headers['access-control-allow-origin']).toBe(`http://${orgs.B.slug}.localhost:3000`);
      const bad = await http.get('/api/v1/health').set('Origin', 'https://sitio-malicioso.com');
      expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('B no puede ver, verificar, tomar ni borrar el dominio de A', async () => {
      const list = await http.get('/api/v1/domains').set(auth(orgs.B.token)).expect(200);
      expect(list.body.custom).toEqual([]);
      expect(list.body.primaryUrl).toBe(`http://${orgs.B.slug}.localhost:3000`);
      await http.post(`/api/v1/domains/${domainId}/verify`).set(auth(orgs.B.token)).expect(404);
      await http.delete(`/api/v1/domains/${domainId}`).set(auth(orgs.B.token)).expect(404);
      await http.post('/api/v1/domains').set(auth(orgs.B.token)).send({ hostname: customHost }).expect(409);
    });

    it('el dominio verificado puede ser el principal', async () => {
      await http.post(`/api/v1/domains/${domainId}/primary`).set(auth(orgs.A.token)).expect(201);
      const list = await http.get('/api/v1/domains').set(auth(orgs.A.token)).expect(200);
      expect(list.body.primaryUrl).toBe(`https://${customHost}`);
    });

    it('el login desde el host de A rechaza usuarios de B', async () => {
      await http.post('/api/v1/auth/login').send({ email: `dm-B-${run}@test.co`, password: 'Clave12345!', organizationId: orgs.A.id }).expect(401);
    });
  });

  describe('medidores', () => {
    it('un suscriptor no puede tener dos medidores activos', async () => {
      await http.post('/api/v1/meters').set(auth(orgs.A.token))
        .send({ subscriberId: orgs.A.subscriberId, serial: `SER-A2-${run}`, installedAt: '2026-01-01', initialReading: 0 }).expect(409);
    });

    it('B no puede instalar un medidor a un suscriptor de A', async () => {
      await http.post('/api/v1/meters').set(auth(orgs.B.token))
        .send({ subscriberId: orgs.A.subscriberId, serial: `SER-X-${run}`, installedAt: '2026-01-01', initialReading: 0 }).expect(404);
    });

    it('la BD impide enlazar una lectura de A con el medidor de B (FK compuesta)', async () => {
      await expect(
        appRole.$transaction([
          appRole.$executeRaw`SELECT set_config('app.current_org', ${orgs.A.id}, TRUE)`,
          appRole.$executeRaw`INSERT INTO tenant.meter_readings
            (id, organization_id, meter_id, subscriber_id, period, reading_date, value, previous_value, consumption_m3, updated_at)
            VALUES (gen_random_uuid(), ${orgs.A.id}::uuid, ${orgs.B.meterId}::uuid, ${orgs.A.subscriberId}::uuid, '2026-01', now(), 1, 0, 1, now())`,
        ]),
      ).rejects.toThrow(/foreign key|readings_meter_same_org_fkey/);
    });
  });

  describe('lecturas', () => {
    const save = (token: string, period: string, entries: any[]) =>
      http.post('/api/v1/readings').set(auth(token)).send({ period, readingDate: `${period}-28`, entries });

    it('calcula consumo desde la lectura inicial del medidor', async () => {
      const res = await save(orgs.A.token, '2026-01', [{ meterId: orgs.A.meterId, value: 115 }]).expect(201);
      expect(res.body.results[0]).toMatchObject({ ok: true, consumptionM3: 15, anomaly: null });
    });

    it('sin lectura exige causal y estima por promedio', async () => {
      await save(orgs.A.token, '2026-02', [{ meterId: orgs.A.meterId, value: null }]).expect(400);
      const res = await save(orgs.A.token, '2026-02', [{ meterId: orgs.A.meterId, value: null, observation: 'predio_cerrado' }]).expect(201);
      expect(res.body.results[0]).toMatchObject({ ok: true, consumptionM3: 15, isEstimated: true, anomaly: 'estimated' });
    });

    it('la siguiente lectura parte del último valor realmente leído', async () => {
      const res = await save(orgs.A.token, '2026-03', [{ meterId: orgs.A.meterId, value: 140 }]).expect(201);
      expect(res.body.results[0]).toMatchObject({ ok: true, consumptionM3: 25 });
    });

    it('lectura menor a la anterior se marca como negativa y no factura consumo negativo', async () => {
      const res = await save(orgs.B.token, '2026-01', [{ meterId: orgs.B.meterId, value: 90 }]).expect(201);
      expect(res.body.results[0]).toMatchObject({ ok: true, consumptionM3: 0, anomaly: 'negative' });
    });

    it('no se puede corregir un período si ya hay lecturas posteriores', async () => {
      const res = await save(orgs.A.token, '2026-01', [{ meterId: orgs.A.meterId, value: 120 }]).expect(201);
      expect(res.body.results[0]).toMatchObject({ ok: false, error: 'Ya hay lecturas de períodos posteriores' });
    });

    it('B no puede registrar lecturas en el medidor de A', async () => {
      const res = await save(orgs.B.token, '2026-04', [{ meterId: orgs.A.meterId, value: 200 }]).expect(201);
      expect(res.body.results[0]).toMatchObject({ ok: false, error: 'Medidor no encontrado' });
    });

    it('la planilla muestra solo los medidores del acueducto, con lectura anterior y promedio', async () => {
      const sheetA = await http.get('/api/v1/readings/sheet?period=2026-04').set(auth(orgs.A.token)).expect(200);
      expect(sheetA.body).toHaveLength(1);
      expect(sheetA.body[0]).toMatchObject({ meterId: orgs.A.meterId, previousValue: 140, averageM3: 20, reading: null });
      const sheetB = await http.get('/api/v1/readings/sheet?period=2026-04').set(auth(orgs.B.token)).expect(200);
      expect(sheetB.body.map((r: any) => r.meterId)).toEqual([orgs.B.meterId]);
      await http.get('/api/v1/readings/sheet?period=2026-13').set(auth(orgs.A.token)).expect(400);
    });

    it('resumen y tablero del período', async () => {
      const res = await http.get('/api/v1/dashboard?period=2026-03').set(auth(orgs.A.token)).expect(200);
      expect(res.body).toMatchObject({ subscribers: 1, readings: { activeMeters: 1, read: 1, pending: 0, totalM3: 25 } });
    });
  });
});
