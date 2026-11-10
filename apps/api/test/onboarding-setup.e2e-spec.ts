/**
 * Asistente de configuración: perfil regulatorio → obligaciones, tarifas, marca, importación Excel y cierre.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { nitCheckDigit } from '@agua-mata/shared';
import { createApp } from '../src/main';
import { sid } from './helpers';

const run = (Date.now() + 1).toString().slice(-7);
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });

async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('suscriptores');
  ws.addRow(['codigo', 'nombre_completo', 'documento', 'direccion', 'estrato']);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('Asistente de configuración inicial', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const orgs = { A: { id: '', token: '' }, B: { id: '', token: '' } };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    for (const [tag, suffix] of [['A', '3'], ['B', '4']] as const) {
      const nit = `8${run}${suffix}`;
      const email = `setup-${tag}-${run}@test.co`;
      const reg = await http.post('/api/v1/onboarding/organizations').send({
        name: `Acueducto Setup ${tag} ${run}`, legalName: `Asociación Setup ${tag} ${run}`, nit, nitDv: nitCheckDigit(nit),
        department: 'Boyacá', municipality: 'Tunja', organizationType: 'asociacion_usuarios', estimatedSubscribers: 120,
        contactEmail: email, contactPhone: '3001234567', owner: { fullName: `Dueño ${tag}`, email, password: 'Clave12345!' },
      }).expect(201);
      orgs[tag].id = reg.body.organizationId;
      orgs[tag].token = sid(await http.post('/api/v1/auth/login').send({ email, password: 'Clave12345!' }).expect(201));
    }
  });

  afterAll(async () => {
    const ids = [orgs.A.id, orgs.B.id].filter(Boolean);
    const where = { organizationId: { in: ids } };
    await owner.complianceItem.deleteMany({ where });
    await owner.tariffSchedule.deleteMany({ where });
    await owner.subscriber.deleteMany({ where });
    const users = await owner.membership.findMany({ where, select: { userId: true } });
    await owner.organization.deleteMany({ where: { id: { in: ids } } });
    await owner.user.deleteMany({ where: { id: { in: users.map((u) => u.userId) } } });
    await Promise.all([owner.$disconnect(), app?.close()]);
  });

  it('al inicio no se puede cerrar el asistente', async () => {
    const s = await http.get('/api/v1/setup/state').set(auth(orgs.A.token)).expect(200);
    expect(s.body.steps).toEqual({ profile: false, tariff: false, branding: false, subscribers: false });
    await http.post('/api/v1/setup/complete').set(auth(orgs.A.token)).expect(400);
  });

  it('el perfil regulatorio activa las obligaciones que corresponden', async () => {
    await http.put('/api/v1/setup/profile').set(auth(orgs.A.token)).send({
      legalNature: 'sin_animo_lucro', providerType: 'organizacion_autorizada', areaType: 'rural', altitudeMasl: 2700, estimatedSubscribers: 120,
    }).expect(200);
    const codes = (await http.get('/api/v1/compliance').set(auth(orgs.A.token)).expect(200)).body.map((i: any) => i.obligationCode);
    expect(codes).toEqual(expect.arrayContaining(['rups', 'sui', 'esquema_rural', 'registro_esal', 'tarifa_pequenos']));
    expect(codes).not.toContain('tarifa_grandes');

    const s = await http.get('/api/v1/setup/state').set(auth(orgs.A.token)).expect(200);
    expect(s.body.suggestedBasicConsumptionM3).toBe(16);
  });

  it('al cambiar el perfil, quita lo que ya no aplica pero conserva el trabajo registrado', async () => {
    await http.patch('/api/v1/compliance/registro_esal').set(auth(orgs.A.token)).send({ status: 'done', notes: 'Certificado 2026' }).expect(200);
    await http.put('/api/v1/setup/profile').set(auth(orgs.A.token)).send({
      legalNature: 'sociedad_por_acciones', providerType: 'esp', areaType: 'urbana', altitudeMasl: 2700, estimatedSubscribers: 6000,
    }).expect(200);
    const codes = (await http.get('/api/v1/compliance').set(auth(orgs.A.token)).expect(200)).body.map((i: any) => i.obligationCode);
    expect(codes).toContain('tarifa_grandes');
    expect(codes).not.toContain('esquema_rural');
    expect(codes).not.toContain('tarifa_pequenos');
    expect(codes).toContain('registro_esal'); // estaba "done": no se borra
  });

  it('B no ve las obligaciones de A', async () => {
    const res = await http.get('/api/v1/compliance').set(auth(orgs.B.token)).expect(200);
    expect(res.body).toEqual([]);
  });

  const tariff = {
    name: 'Tarifa 2026', effectiveFrom: '2026-01-01', billingPeriod: 'monthly', basicConsumptionM3: 16,
    fixedCharge: 8500, rateBasic: 1250, rateComplementary: 1600, rateSumptuary: 1900,
    stratumFactors: { '1': -50, '2': -40, '3': -15, '4': 0, '5': 50, '6': 60, comercial: 50 },
  };

  it('rechaza subsidios por encima del tope legal', async () => {
    await http.put('/api/v1/setup/tariff').set(auth(orgs.A.token)).send({ ...tariff, stratumFactors: { '1': -80 } }).expect(400);
  });

  it('una tarifa nueva reemplaza a la vigente y conserva el historial', async () => {
    await http.put('/api/v1/setup/tariff').set(auth(orgs.A.token)).send(tariff).expect(200);
    await http.put('/api/v1/setup/tariff').set(auth(orgs.A.token)).send({ ...tariff, name: 'Tarifa 2026 ajustada', fixedCharge: 9000 }).expect(200);
    const all = await owner.tariffSchedule.findMany({ where: { organizationId: orgs.A.id } });
    expect(all).toHaveLength(2);
    expect(all.filter((t) => t.isActive).map((t) => t.name)).toEqual(['Tarifa 2026 ajustada']);
  });

  it('marca: colores, rechazo de SVG y logo PNG público', async () => {
    await http.put('/api/v1/setup/branding').set(auth(orgs.A.token)).send({ primaryColor: '#0b6e99', secondaryColor: '#f2a900' }).expect(200);
    await http.post('/api/v1/setup/branding/logo').set(auth(orgs.A.token))
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { filename: 'logo.svg', contentType: 'image/svg+xml' })
      .expect(400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    await http.post('/api/v1/setup/branding/logo').set(auth(orgs.A.token)).attach('file', png, { filename: 'logo.png', contentType: 'image/png' }).expect(201);
    const logo = await http.get(`/api/v1/public/orgs/${orgs.A.id}/logo`).expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
    await http.get(`/api/v1/public/orgs/${orgs.B.id}/logo`).expect(404);
  });

  it('la plantilla de Excel se descarga con los encabezados esperados', async () => {
    const res = await http.get('/api/v1/imports/subscribers/template').set(auth(orgs.A.token)).buffer(true)
      .parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets[0].getRow(1).values).toEqual([undefined, 'codigo', 'nombre_completo', 'documento', 'direccion', 'estrato', 'uso']);
  });

  it('importación: la validación reporta errores y no importa nada', async () => {
    await http.post('/api/v1/subscribers').set(auth(orgs.A.token))
      .send({ code: 'E-1', fullName: 'Ya Existente', documentNumber: '555', address: 'Calle 1' }).expect(201);
    const file = await xlsx([
      ['100', 'Ana Ruiz', '1001', 'Vereda Alta', 1],
      ['100', 'Duplicado', '1002', 'Vereda Alta', 1],
      ['101', '', '1003', 'Vereda Baja', 2],
      ['E-1', 'Choca con existente', '1004', 'Centro', 3],
      ['102', 'Estrato raro', '1005', 'Centro', 9],
      [null, null, null, null, null],
    ]);
    const res = await http.post('/api/v1/imports/subscribers?dryRun=false').set(auth(orgs.A.token))
      .attach('file', file, 'suscriptores.xlsx').expect(201);
    expect(res.body.imported).toBe(0);
    expect(res.body.totalRows).toBe(5);
    expect(res.body.issues.map((i: any) => i.row)).toEqual([3, 4, 5, 6]);
    expect(await owner.subscriber.count({ where: { organizationId: orgs.A.id } })).toBe(1);
  });

  it('importación: un archivo válido se importa solo en el tenant actual', async () => {
    const file = await xlsx([
      ['200', 'Luis Gómez', '2001', 'Vereda Alta', 1],
      ['201', 'Rosa Díaz', '2002', 'Vereda Baja', 2],
      ['202', 'Pedro Mora', '2003', 'Centro', null],
    ]);
    const dry = await http.post('/api/v1/imports/subscribers').set(auth(orgs.A.token)).attach('file', file, 'ok.xlsx').expect(201);
    expect(dry.body).toMatchObject({ dryRun: true, validRows: 3, imported: 0, issueCount: 0 });

    const res = await http.post('/api/v1/imports/subscribers?dryRun=false').set(auth(orgs.A.token)).attach('file', file, 'ok.xlsx').expect(201);
    expect(res.body.imported).toBe(3);
    expect(await owner.subscriber.count({ where: { organizationId: orgs.A.id } })).toBe(4);
    const b = await http.get('/api/v1/subscribers').set(auth(orgs.B.token)).expect(200);
    expect(b.body).toEqual([]);
  });

  it('con perfil y tarifa, el asistente se cierra y la organización queda activa', async () => {
    const res = await http.post('/api/v1/setup/complete').set(auth(orgs.A.token)).expect(201);
    expect(res.body.status).toBe('active');
    const s = await http.get('/api/v1/setup/state').set(auth(orgs.A.token)).expect(200);
    expect(s.body.steps).toEqual({ profile: true, tariff: true, branding: true, subscribers: true });
  });
});
