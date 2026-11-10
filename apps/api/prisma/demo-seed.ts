/**
 * DATOS DE DEMOSTRACIÓN para un acueducto existente: simula cuatro meses de operación (julio a octubre de 2026)
 * usando la API real, así facturas, subsidios, intereses, abonos, cartera y auditoría quedan calculados igual
 * que en el uso normal.
 *
 *   pnpm --filter @agua-mata/api demo:seed                 # carga la demo en "agua-mata"
 *   pnpm --filter @agua-mata/api demo:seed -- --reset      # borra la demo y deja el acueducto como estaba
 *   ... -- --org=<slug>                                    # otro acueducto
 *
 * Requiere la API corriendo (pnpm dev). Abre una sesión temporal del dueño directamente en la BD (no necesita su
 * contraseña) y la cierra al terminar. Los suscriptores de la demo usan códigos 0101 a 0199 y los usuarios
 * correos @demo.aguamata.co, para poder borrarlos sin tocar los datos reales.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const API = process.env.DEMO_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}/api/v1`;
const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
const args = process.argv.slice(2);
const SLUG = args.find((a) => a.startsWith('--org='))?.slice(6) ?? 'agua-mata';
const RESET = args.includes('--reset');
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const DEMO_EMAIL_DOMAIN = '@demo.aguamata.co';
const DEMO_PASSWORD = 'Demo12345!';
const DEMO_TARIFF = 'Tarifa 2026 (demo)';
const PERIODS = ['2026-07', '2026-08', '2026-09', '2026-10'];
const BILLING_OPTIONS = { missingReadings: 'block', unmeteredConsumptionM3: 12 };

// ───────────── Utilidades ─────────────

let token = '';
async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json?.message ?? text}${json?.issues ? ` ${JSON.stringify(json.issues)}` : ''}`);
  return json as T;
}

/** Números pseudoaleatorios reproducibles: la demo sale igual cada vez. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261110);
const between = (a: number, b: number) => Math.round(a + rand() * (b - a));
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const nextMonthFirst = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
const log = (s: string) => console.log(`  ${s}`);

// ───────────── Escenario ─────────────

type Behavior = 'puntual' | 'tarde' | 'parcial' | 'moroso_reconectado' | 'moroso_suspendido' | 'moroso_lista' | 'sin_pagar_octubre';
interface DemoSub {
  code: string; fullName: string; documentNumber: string; address: string; stratum?: number; usage?: string;
  behavior: Behavior; m3: number; meter: boolean; special?: 'vacia' | 'fuga_octubre' | 'cerrado_septiembre' | 'danado_octubre';
  id?: string; meterId?: string; reading?: number;
}

const SUBS: DemoSub[] = [
  { code: '0101', fullName: 'María Elena Bastidas Ortiz', documentNumber: '27081234', address: 'Vereda Mata, casa 1', stratum: 1, behavior: 'puntual', m3: 11, meter: true },
  { code: '0102', fullName: 'José Antonio Guerrero Pantoja', documentNumber: '12981456', address: 'Vereda Mata, casa 4', stratum: 1, behavior: 'puntual', m3: 14, meter: true },
  { code: '0103', fullName: 'Rosa Amelia Chamorro', documentNumber: '27093311', address: 'Vereda Mata, casa 7', stratum: 2, behavior: 'tarde', m3: 16, meter: true },
  { code: '0104', fullName: 'Luis Fernando Erazo', documentNumber: '98345120', address: 'Sector El Alto, lote 2', stratum: 2, behavior: 'puntual', m3: 13, meter: true },
  { code: '0105', fullName: 'Carmen Sofía Rosero', documentNumber: '36955120', address: 'Sector El Alto, lote 5', stratum: 1, behavior: 'parcial', m3: 12, meter: true },
  { code: '0106', fullName: 'Pedro Pablo Insuasty', documentNumber: '5204771', address: 'Sector El Alto, lote 9', stratum: 1, behavior: 'moroso_reconectado', m3: 15, meter: true },
  { code: '0107', fullName: 'Ana Lucía Benavides', documentNumber: '30734512', address: 'Camino Real, casa 3', stratum: 2, behavior: 'puntual', m3: 10, meter: true, special: 'cerrado_septiembre' },
  { code: '0108', fullName: 'Jesús Arturo Delgado', documentNumber: '87061234', address: 'Camino Real, casa 8', stratum: 2, behavior: 'moroso_suspendido', m3: 17, meter: true },
  { code: '0109', fullName: 'Gloria Inés Muñoz', documentNumber: '27250987', address: 'Camino Real, casa 11', stratum: 3, behavior: 'puntual', m3: 18, meter: true, special: 'fuga_octubre' },
  { code: '0110', fullName: 'Hernando Villota', documentNumber: '12754321', address: 'Camino Real, casa 14', stratum: 3, behavior: 'tarde', m3: 20, meter: true },
  { code: '0111', fullName: 'Familia Ortega Cuastumal', documentNumber: '1085234567', address: 'La Loma, casa 2', stratum: 1, behavior: 'moroso_lista', m3: 13, meter: true },
  { code: '0112', fullName: 'Diana Marcela López', documentNumber: '1085345678', address: 'La Loma, casa 6', stratum: 2, behavior: 'puntual', m3: 9, meter: true },
  { code: '0113', fullName: 'Casa de veraneo Narváez', documentNumber: '13071234', address: 'La Loma, casa 10', stratum: 4, behavior: 'puntual', m3: 0, meter: true, special: 'vacia' },
  { code: '0114', fullName: 'Jorge Eliécer Cabrera', documentNumber: '98156789', address: 'La Loma, casa 12', stratum: 5, behavior: 'puntual', m3: 26, meter: true },
  { code: '0115', fullName: 'Tienda Doña Lucha', documentNumber: '900456123', address: 'Plaza de la vereda, local 1', usage: 'comercial', behavior: 'puntual', m3: 32, meter: true },
  { code: '0116', fullName: 'Restaurante El Fogón Nariñense', documentNumber: '901234987', address: 'Vía principal km 3', usage: 'comercial', behavior: 'parcial', m3: 44, meter: true, special: 'danado_octubre' },
  { code: '0117', fullName: 'Institución Educativa Rural Mata', documentNumber: '800123456', address: 'Vía principal km 2', usage: 'oficial', behavior: 'puntual', m3: 38, meter: true },
  { code: '0118', fullName: 'Segundo Ignacio Paz', documentNumber: '5281234', address: 'Sector Las Palmas, casa 1', stratum: 1, behavior: 'sin_pagar_octubre', m3: 12, meter: true },
  { code: '0119', fullName: 'Martha Cecilia Jojoa', documentNumber: '27345678', address: 'Sector Las Palmas, casa 3', stratum: 2, behavior: 'puntual', m3: 15, meter: true },
  { code: '0120', fullName: 'Wilson Andrés Tutistar', documentNumber: '1085456789', address: 'Sector Las Palmas, casa 5', stratum: 1, behavior: 'puntual', m3: 0, meter: false },
  { code: '0121', fullName: 'Blanca Nubia Revelo', documentNumber: '27456789', address: 'Sector Las Palmas, casa 7', stratum: 1, behavior: 'tarde', m3: 0, meter: false },
  { code: '0122', fullName: 'Óscar Darío Yépez', documentNumber: '98567890', address: 'Sector Las Palmas, casa 9', stratum: 2, behavior: 'puntual', m3: 14, meter: true },
];

/** Tarifa realista de referencia para la demo (los valores reales los fija el estudio de costos). */
const TARIFF = {
  name: DEMO_TARIFF, effectiveFrom: '2026-07-01', billingPeriod: 'monthly', basicConsumptionM3: 13,
  fixedCharge: 6800, rateBasic: 1450, rateComplementary: 1450, rateSumptuary: 2150,
  stratumFactors: { '1': -50, '2': -35, '3': -12, '4': 0, '5': 30, '6': 40, comercial: 30, industrial: 30, oficial: 0 },
};

// ───────────── Programa ─────────────

async function openSession() {
  const org = await db.organization.findUnique({ where: { slug: SLUG } });
  if (!org) throw new Error(`No existe un acueducto con slug "${SLUG}"`);
  const owner = await db.membership.findFirst({ where: { organizationId: org.id, role: 'owner', status: 'active' }, include: { user: true }, orderBy: { createdAt: 'asc' } });
  if (!owner) throw new Error('El acueducto no tiene un dueño activo');
  const raw = randomBytes(32).toString('base64url');
  const session = await db.session.create({
    data: {
      userId: owner.userId, organizationId: org.id, tokenHash: createHash('sha256').update(raw).digest('hex'),
      userAgent: 'demo-seed', expiresAt: new Date(Date.now() + 2 * 3_600_000),
    },
  });
  token = raw;
  return { org, owner: owner.user, sessionId: session.id };
}

async function reset(orgId: string) {
  console.log('Borrando la demo…');
  const subs = await db.subscriber.findMany({ where: { organizationId: orgId, code: { gte: '0101', lte: '0199' } }, select: { id: true } });
  const subIds = subs.map((s) => s.id);
  const real = await db.subscriber.findMany({ where: { organizationId: orgId, id: { notIn: subIds } }, select: { id: true } });
  const all = { organizationId: orgId };
  // La facturación y el recaudo de la demo incluyen también al suscriptor real (si lo había): se borra toda la operación.
  await db.eInvoiceDocument.deleteMany({ where: all });
  await db.paymentAllocation.deleteMany({ where: all });
  await db.payment.deleteMany({ where: all });
  await db.serviceEvent.deleteMany({ where: all });
  await db.subscriberCharge.deleteMany({ where: all });
  await db.invoiceLine.deleteMany({ where: all });
  await db.invoice.deleteMany({ where: all });
  await db.billingPeriod.deleteMany({ where: all });
  await db.meterReading.deleteMany({ where: all });
  await db.meter.deleteMany({ where: all });
  await db.subscriber.deleteMany({ where: { id: { in: subIds } } });
  await db.subscriber.updateMany({ where: { id: { in: real.map((r) => r.id) } }, data: { serviceStatus: 'connected' } });
  // Tarifa: se borra la de la demo y se reactiva la más reciente del acueducto.
  await db.tariffSchedule.deleteMany({ where: { organizationId: orgId, name: DEMO_TARIFF } });
  const prev = await db.tariffSchedule.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' } });
  if (prev) await db.tariffSchedule.update({ where: { id: prev.id }, data: { isActive: true } });
  await db.organization.update({ where: { id: orgId }, data: { collectionSettings: {} } });
  await db.complianceItem.updateMany({ where: { organizationId: orgId }, data: { status: 'pending', notes: null, dueDate: null } });
  // Personal de la demo.
  const demoUsers = await db.user.findMany({ where: { email: { endsWith: DEMO_EMAIL_DOMAIN } }, select: { id: true } });
  await db.invitation.deleteMany({ where: { organizationId: orgId, email: { endsWith: DEMO_EMAIL_DOMAIN } } });
  await db.membership.deleteMany({ where: { organizationId: orgId, userId: { in: demoUsers.map((u) => u.id) } } });
  await db.user.deleteMany({ where: { id: { in: demoUsers.map((u) => u.id) } } });
  await db.backgroundJob.deleteMany({ where: { organizationId: orgId } });
  log(`Listo: ${subIds.length} suscriptores de demo y toda la facturación, recaudo, lecturas y medidores borrados.`);
  log('La bitácora de auditoría no se borra (es de solo inserción).');
}

async function seed(orgId: string) {
  const existing = await db.subscriber.count({ where: { organizationId: orgId, code: { gte: '0101', lte: '0199' } } });
  const invoices = await db.invoice.count({ where: { organizationId: orgId } });
  if (existing || invoices) throw new Error('El acueducto ya tiene datos de demo o facturas. Corre primero con --reset');

  console.log('1. Configuración');
  await call('PUT', '/setup/tariff', TARIFF);
  log(`Tarifa "${DEMO_TARIFF}" vigente (la anterior queda en el historial).`);
  await call('PUT', '/collections/settings', {
    lateInterestEnabled: true, residentialMonthlyRatePct: 1.5, nonResidentialMonthlyRatePct: 2, graceDays: 5, reconnectionFee: 35000, suspensionMinOverdue: 2,
  });
  log('Intereses de mora (1,5 % / 2 % mensual), reconexión de $35.000 y lista de suspensión desde 2 facturas vencidas.');
  const compliance: [string, string, string | null, string][] = [
    ['rups', 'done', null, 'Inscrito en el RUPS. Actualización anual hecha en marzo.'],
    ['ccu', 'done', null, 'Contrato de condiciones uniformes aprobado en asamblea y publicado en la oficina.'],
    ['concesion_aguas', 'in_progress', '2026-12-15', 'Renovación radicada en Corponariño; pendiente visita técnica.'],
    ['calidad_agua', 'in_progress', '2026-11-30', 'Muestreo mensual con la Secretaría de Salud.'],
    ['sui', 'pending', '2026-11-30', 'Cargue del tercer trimestre.'],
  ];
  for (const [code, status, dueDate, notes] of compliance) {
    await call('PATCH', `/compliance/${code}`, { status, dueDate, notes }).catch((e) => log(`(no se pudo actualizar ${code}: ${e.message})`));
  }
  log('Obligaciones regulatorias con avance.');

  console.log('2. Equipo');
  const team: [string, string, string][] = [
    ['laura.gomez', 'Laura Gómez Rosero', 'admin'],
    ['carlos.ruiz', 'Carlos Ruiz Pantoja', 'operator'],
  ];
  for (const [user, fullName, role] of team) {
    const inv = await call('POST', '/team/invitations', { email: `${user}${DEMO_EMAIL_DOMAIN}`, role });
    const t = new URL(inv.inviteUrl).searchParams.get('token')!;
    await call('POST', `/public/invitations/${t}/accept`, { fullName, password: DEMO_PASSWORD });
    log(`${fullName} (${role}) · ${user}${DEMO_EMAIL_DOMAIN} / ${DEMO_PASSWORD}`);
  }
  await call('POST', '/team/invitations', { email: `revisor.fiscal${DEMO_EMAIL_DOMAIN}`, role: 'reader' });
  log('Invitación pendiente para el revisor fiscal (solo consulta).');

  console.log('3. Suscriptores y medidores');
  const real = await call<any[]>('GET', '/subscribers');
  for (const r of real.filter((s) => !/^01\d\d$/.test(s.code))) {
    // El suscriptor real entra a la demo como cliente puntual con medidor.
    await call('PATCH', `/subscribers/${r.id}`, { stratum: r.stratum ?? 2 }).catch(() => undefined);
    SUBS.push({ code: r.code, fullName: r.fullName, documentNumber: r.documentNumber, address: r.address, behavior: 'puntual', m3: 14, meter: true, id: r.id });
  }
  for (const s of SUBS) {
    if (!s.id) {
      const created = await call('POST', '/subscribers', {
        code: s.code, fullName: s.fullName, documentNumber: s.documentNumber, address: s.address, ...(s.stratum ? { stratum: s.stratum } : {}), usage: s.usage ?? 'residencial',
      });
      s.id = created.id;
    }
    if (s.meter) {
      s.reading = between(80, 900);
      const m = await call('POST', '/meters', {
        subscriberId: s.id, serial: `AM-${s.code}-${between(1000, 9999)}`, brand: rand() > 0.5 ? 'Elster' : 'Itron', diameter: '1/2"',
        installedAt: '2026-06-15', initialReading: s.reading,
      });
      s.meterId = m.id;
    }
  }
  log(`${SUBS.length} suscriptores (${SUBS.filter((s) => !s.meter).length} sin medidor, facturados por aforo de 12 m³).`);

  console.log('4. Operación mes a mes (lecturas → facturación → pagos, suspensiones y reconexiones)');
  type Ev = { date: string; order: number; run: () => Promise<void> };
  const events: Ev[] = [];
  const at = (date: string, order: number, run: () => Promise<void>) => events.push({ date, order, run });
  const byCode = (c: string) => SUBS.find((s) => s.code === c)!;
  const suspended = new Set<string>();
  const counts = { payments: 0, skippedFuture: 0 };
  /** Fecha del evento que se está procesando (la usan los pagos programados). */
  let eventDate = '';

  async function pay(s: DemoSub, date: string, mode: { kind: 'amount'; amount: number } | { kind: 'half'; amount: number } | { kind: 'balance' }, method = 'efectivo', reference?: string) {
    if (date > TODAY) return;
    const st = await call('GET', `/payments/statement/${s.id}`);
    const target = mode.kind === 'balance' ? st.balance : mode.kind === 'half' ? Math.round(mode.amount / 2 / 100) * 100 : mode.amount;
    const amount = Math.min(target, st.balance);
    if (amount <= 0) return;
    const p = await call('POST', '/payments', { subscriberId: s.id, amount, paidAt: date, method, ...(reference ? { reference } : {}) });
    counts.payments++;
    return p;
  }

  for (const period of PERIODS) {
    const issueDate = nextMonthFirst(period);
    const dueDate = addDays(issueDate, 14);
    at(issueDate, 0, async () => {
      // Lecturas del período.
      const entries = SUBS.filter((s) => s.meterId).map((s) => {
        if (s.special === 'cerrado_septiembre' && period === '2026-09') return { meterId: s.meterId!, value: null, observation: 'predio_cerrado' };
        if (s.special === 'danado_octubre' && period === '2026-10') return { meterId: s.meterId!, value: null, observation: 'medidor_danado' };
        let m3 = s.special === 'vacia' || suspended.has(s.code) ? 0 : Math.max(1, s.m3 + between(-3, 3));
        if (s.special === 'fuga_octubre' && period === '2026-10') m3 = s.m3 * 3;
        s.reading = (s.reading ?? 0) + m3;
        return { meterId: s.meterId!, value: s.reading };
      });
      await call('POST', '/readings', { period, readingDate: `${period}-28`, entries });
      const res = await call('POST', '/billing/issue', { period, options: BILLING_OPTIONS, issueDate, dueDate });
      const bp = await call('GET', `/billing/periods/${period}`);
      log(`${period}: ${res.invoices} facturas (N.º ${res.firstNumber}–${res.lastNumber}) por $${Math.round(res.total).toLocaleString('es-CO')}, emitidas el ${issueDate}.`);
      // Pagos de las facturas de este período según el comportamiento de cada suscriptor.
      for (const inv of bp.invoices) {
        const s = SUBS.find((x) => x.code === inv.subscriberSnapshot.code);
        if (!s) continue;
        const total = Number(inv.total);
        switch (s.behavior) {
          case 'puntual': at(addDays(issueDate, between(2, 12)), 2, async () => { await pay(s, eventDate, { kind: 'amount', amount: total }, rand() > 0.6 ? 'transferencia' : 'efectivo', rand() > 0.6 ? `TRX${between(100000, 999999)}` : undefined); }); break;
          case 'tarde': at(addDays(issueDate, 35), 2, async () => { await pay(s, eventDate, { kind: 'amount', amount: total }); }); break;
          case 'parcial': at(addDays(issueDate, between(8, 13)), 2, async () => { await pay(s, eventDate, { kind: 'half', amount: total }); }); break;
          case 'moroso_lista': if (period === '2026-07') at(addDays(issueDate, 20), 2, async () => { await pay(s, eventDate, { kind: 'amount', amount: total }); }); break;
          case 'sin_pagar_octubre': if (period !== '2026-10') at(addDays(issueDate, between(3, 10)), 2, async () => { await pay(s, eventDate, { kind: 'amount', amount: total }); }); break;
          default: break; // morosos: no pagan
        }
      }
    });
  }

  // Un pago registrado al suscriptor equivocado y anulado (para ver la anulación con motivo). 0103 paga tarde: tiene deuda ese día.
  at('2026-09-09', 3, async () => {
    const wrong = await pay(byCode('0103'), '2026-09-09', { kind: 'amount', amount: 5000 }, 'efectivo');
    if (wrong) await call('POST', `/payments/${wrong.id}/void`, { reason: 'Se registró a Rosa Amelia Chamorro, pero el pago era de José Antonio Guerrero' });
  });
  // Cargos adicionales: uno ya facturado en octubre y otro pendiente para noviembre.
  at('2026-10-10', 1, async () => { await call('POST', '/collections/charges', { subscriberId: byCode('0102').id, description: 'Revisión y cambio de registro de la acometida', amount: 18000 }); });
  at('2026-11-07', 1, async () => { await call('POST', '/collections/charges', { subscriberId: byCode('0115').id, description: 'Visita técnica por baja presión', amount: 12000 }); });
  // Suspensiones y reconexión.
  at('2026-10-20', 4, async () => {
    await call('POST', `/collections/subscribers/${byCode('0106').id}/suspend`, { date: '2026-10-20', reason: 'Tres facturas vencidas sin pago (Ley 142, art. 140)', notes: 'Se cerró el registro y se dejó notificación escrita.' });
    suspended.add('0106');
  });
  at('2026-11-03', 4, async () => {
    await call('POST', `/collections/subscribers/${byCode('0108').id}/suspend`, { date: '2026-11-03', reason: 'Facturas de julio a septiembre vencidas sin pago', notes: 'No atendió dos avisos de cobro.' });
    suspended.add('0108');
  });
  at('2026-11-05', 2, async () => { await pay(byCode('0106'), '2026-11-05', { kind: 'balance' }, 'consignacion', `CONS-${between(10000, 99999)}`); });
  at('2026-11-06', 4, async () => {
    await call('POST', `/collections/subscribers/${byCode('0106').id}/reconnect`, { date: '2026-11-06', reconnectionFee: null, allowWithDebt: false, notes: 'Pagó la totalidad de la deuda.' });
    suspended.delete('0106');
  });

  // Se procesan en orden de fecha (las emisiones generan nuevos eventos de pago).
  for (;;) {
    events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
    const ev = events.shift();
    if (!ev) break;
    if (ev.date > TODAY) { counts.skippedFuture++; continue; }
    eventDate = ev.date;
    await ev.run();
  }
  log(`${counts.payments} pagos registrados. ${counts.skippedFuture} movimientos con fecha posterior a hoy no se registraron (las facturas de octubre siguen abiertas).`);

  console.log('5. Resumen');
  const r = await call('GET', '/receivables');
  log(`Cartera al ${TODAY}: $${Math.round(r.total).toLocaleString('es-CO')} por cobrar, $${Math.round(r.overdue).toLocaleString('es-CO')} vencidos · ${r.suspensionCandidates} en lista de suspensión.`);
}

async function main() {
  console.log(`Demo de ${SLUG} contra ${API}`);
  await fetch(`${API}/health`).catch(() => { throw new Error('La API no responde. Arranca pnpm dev y vuelve a intentarlo'); });
  const { org, sessionId } = await openSession();
  try {
    if (RESET) await reset(org.id);
    else await seed(org.id);
  } finally {
    await db.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
});
