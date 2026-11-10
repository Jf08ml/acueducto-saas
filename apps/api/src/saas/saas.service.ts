import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  addCycle, adjustSubscriptionSchema, BillingCycle, CYCLE_LABEL, cyclePrice, DEFAULT_PLAN_CODE, DEFAULT_SAAS_SETTINGS, manualPaymentSchema,
  reportTransferSchema, SaasSettings, saasSettingsSchema, subscriptionActions, updatePlanSchema,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { emailLayout, MailService } from '../mail/mail.service';
import { StorageService } from '../storage/storage.service';
import { JobsService } from '../jobs/jobs.module';
import { currentContext } from '../common/request-context';
import { orgPublicUrl, platformOrigin } from '../domains/domains.module';
import { MercadoPagoApi, MercadoPagoClient, MpPayment } from './mercadopago';

const SETTINGS_KEY = 'saas';
export const SAAS_DAILY_JOB = 'saas.daily';
const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'suspended'] as const;
const OPEN_INVOICE = ['pending', 'in_review'];
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const PROOF_TYPES: Record<string, { ext: string; magic: number[] }> = {
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'application/pdf': { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] },
};

const money = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const day = (d: Date) => d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric' });

type InvoiceWithOrg = Prisma.SaasInvoiceGetPayload<{ include: { organization: true; subscription: true } }>;

/**
 * Cobro del SaaS a cada acueducto.
 *  - Revisión diaria (tarea programada): emite la factura del siguiente período, marca pago pendiente al vencer
 *    y, al acabar la gracia, deja la cuenta en SOLO LECTURA (nunca se borran ni se ocultan los datos).
 *  - Pago con Mercado Pago (confirmado consultando su API) o por transferencia (comprobante que aprueba el superadmin).
 *  - El superadmin también puede registrar un pago manual o ajustar la fecha de corte (cortesía, activación manual).
 */
@Injectable()
export class SaasService implements OnModuleInit {
  private readonly log = new Logger('Saas');
  private mp: MercadoPagoApi = new MercadoPagoClient();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register(SAAS_DAILY_JOB, () => this.daily());
    this.jobs.schedule(SAAS_DAILY_JOB, '0 6 * * *');
  }

  /** Solo para pruebas. */
  useMercadoPago(client: MercadoPagoApi) {
    this.mp = client;
  }

  // ───────────── Configuración y plan ─────────────

  async settings(): Promise<SaasSettings> {
    const row = await this.prisma.platform.platformSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const parsed = saasSettingsSchema.safeParse({ ...DEFAULT_SAAS_SETTINGS, ...((row?.value as object) ?? {}) });
    return parsed.success ? parsed.data : DEFAULT_SAAS_SETTINGS;
  }

  async updateSettings(input: SaasSettings) {
    await this.prisma.platform.platformSetting.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value: input as Prisma.InputJsonValue, updatedById: currentContext().userId },
      update: { value: input as Prisma.InputJsonValue, updatedById: currentContext().userId },
    });
    await this.audit.log({ action: 'saas.settings_updated', entity: 'platform_setting', entityId: SETTINGS_KEY, data: input as Prisma.InputJsonValue });
    return input;
  }

  defaultPlan() {
    return this.prisma.platform.plan.findUniqueOrThrow({ where: { code: DEFAULT_PLAN_CODE } });
  }

  async updatePlan(id: string, input: z.infer<typeof updatePlanSchema>) {
    const plan = await this.prisma.platform.plan.update({ where: { id }, data: input });
    await this.audit.log({ action: 'saas.plan_updated', entity: 'plan', entityId: id, data: input });
    return plan;
  }

  get mercadoPagoEnabled() {
    return this.mp.enabled;
  }

  // ───────────── Revisión diaria ─────────────

  /**
   * Idempotente: correrla dos veces el mismo día no emite ni suspende dos veces.
   * `only` limita la revisión a ciertos acueductos (pruebas con fechas simuladas).
   */
  async daily(now = new Date(), only?: { organizationIds: string[] }) {
    const cfg = await this.settings();
    const subs = await this.prisma.platform.subscription.findMany({
      where: {
        status: { in: [...LIVE_STATUSES] },
        organization: { status: { not: 'deactivated' } },
        ...(only ? { organizationId: { in: only.organizationIds } } : {}),
      },
      include: { plan: true, organization: true, invoices: { where: { status: { in: OPEN_INVOICE } }, select: { id: true } } },
    });
    const summary = { checked: subs.length, invoiced: 0, pastDue: 0, suspended: 0 };
    for (const s of subs) {
      try {
        const act = subscriptionActions(
          { status: s.status, currentPeriodEnd: s.currentPeriodEnd, graceEndsAt: s.graceEndsAt, hasOpenInvoice: s.invoices.length > 0 },
          now,
          { leadDays: cfg.invoiceLeadDays, graceDays: cfg.graceDays },
        );
        if (act.invoice && (await this.issueNextInvoice(s.id))) summary.invoiced++;
        if (act.pastDue) {
          const moved = await this.prisma.platform.subscription.updateMany({
            where: { id: s.id, status: { in: ['trialing', 'active'] } }, data: { status: 'past_due', graceEndsAt: act.pastDue },
          });
          if (moved.count) {
            summary.pastDue++;
            await this.audit.log({ action: 'saas.subscription_past_due', entity: 'subscription', entityId: s.id, organizationId: s.organizationId, data: { graceEndsAt: act.pastDue.toISOString() } });
            await this.notifyOrg(s.organizationId, 'Tu suscripción tiene un pago pendiente', [
              `El período de ${s.organization.name} en AguaMata terminó el ${day(s.currentPeriodEnd)} y la factura sigue pendiente.`,
              `Tienes hasta el ${day(act.pastDue)} para pagar. Después la cuenta queda en modo de solo lectura hasta que se registre el pago.`,
            ]);
          }
        }
        if (act.suspend) {
          const moved = await this.prisma.platform.subscription.updateMany({ where: { id: s.id, status: { not: 'suspended' } }, data: { status: 'suspended' } });
          if (moved.count) {
            summary.suspended++;
            await this.audit.log({ action: 'saas.subscription_suspended', entity: 'subscription', entityId: s.id, organizationId: s.organizationId });
            await this.notifyOrg(s.organizationId, 'Tu cuenta quedó en modo de solo lectura', [
              `Como la factura de ${s.organization.name} no se pagó a tiempo, la cuenta quedó en modo de solo lectura: puedes consultar y descargar tu información, pero no registrar cambios.`,
              'En cuanto se registre el pago, la cuenta se reactiva de inmediato. No se borra ningún dato.',
            ]);
          }
        }
      } catch (e: any) {
        this.log.error(`Revisión diaria: falló la suscripción ${s.id}: ${e?.message ?? e}`);
      }
    }
    this.log.log(`Revisión diaria: ${JSON.stringify(summary)}`);
    return summary;
  }

  /** Emite la factura del período que sigue al actual. Devuelve null si ya existe. */
  async issueNextInvoice(subscriptionId: string) {
    const s = await this.prisma.platform.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: { plan: true, organization: true } });
    const cycle = s.billingCycle as BillingCycle;
    const periodStart = s.currentPeriodEnd;
    const periodEnd = addCycle(periodStart, cycle);
    const amountCop = cyclePrice(s.plan, cycle);
    let invoice;
    try {
      invoice = await this.prisma.platform.saasInvoice.create({
        data: {
          organizationId: s.organizationId, subscriptionId: s.id, planId: s.planId, billingCycle: cycle,
          periodStart, periodEnd, amountCop, dueDate: periodStart,
        },
      });
    } catch (e) {
      // Índice único parcial: ya hay una factura vigente para ese período (carrera entre dos revisiones).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
    await this.audit.log({ action: 'saas.invoice_issued', entity: 'saas_invoice', entityId: invoice.id, organizationId: s.organizationId, data: { number: invoice.number, amountCop } });
    if (amountCop === 0) {
      await this.confirmPaid(invoice.id, { method: 'manual', reference: 'Sin costo' });
      return invoice;
    }
    await this.notifyOrg(s.organizationId, `Factura N.º ${invoice.number} de AguaMata`, [
      `Ya está disponible la factura de ${s.organization.name} por ${money(amountCop)}: plan ${s.plan.name} (${CYCLE_LABEL[cycle].toLowerCase()}), del ${day(periodStart)} al ${day(periodEnd)}.`,
      `Págala antes del ${day(periodStart)} con Mercado Pago o por transferencia desde la sección Suscripción.`,
    ]);
    return invoice;
  }

  // ───────────── Confirmar pagos ─────────────

  /**
   * Marca la factura como pagada y extiende la suscripción hasta el fin del período facturado.
   * Si la cuenta estaba suspendida, el período nuevo arranca hoy (no se cobra el tiempo en que estuvo suspendida).
   * Idempotente: si ya estaba pagada no hace nada.
   */
  async confirmPaid(invoiceId: string, opts: { method: 'mercadopago' | 'transfer' | 'manual'; reference?: string; paidAt?: Date }) {
    const now = new Date();
    const result = await this.prisma.platform.$transaction(async (tx) => {
      const claimed = await tx.saasInvoice.updateMany({
        where: { id: invoiceId, status: { in: OPEN_INVOICE } },
        data: { status: 'paid', paidAt: opts.paidAt ?? now, paymentMethod: opts.method, paymentReference: opts.reference, confirmedById: currentContext().userId },
      });
      if (claimed.count !== 1) return null;
      const inv = await tx.saasInvoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { subscription: true } });
      const sub = inv.subscription;
      const restart = sub.status === 'suspended' && inv.periodEnd.getTime() < now.getTime();
      const start = restart ? now : inv.periodStart;
      const end = restart ? addCycle(now, inv.billingCycle as BillingCycle) : inv.periodEnd;
      const extend = end.getTime() > sub.currentPeriodEnd.getTime();
      await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'active', graceEndsAt: null, ...(extend ? { currentPeriodStart: start, currentPeriodEnd: end } : {}) },
      });
      return { inv, end: extend ? end : sub.currentPeriodEnd, wasSuspended: sub.status === 'suspended' };
    });
    if (!result) return false;
    await this.audit.log({
      action: 'saas.invoice_paid', entity: 'saas_invoice', entityId: invoiceId, organizationId: result.inv.organizationId,
      data: { method: opts.method, reference: opts.reference ?? null, periodEnd: result.end.toISOString(), reactivated: result.wasSuspended },
    });
    await this.notifyOrg(result.inv.organizationId, `Recibimos tu pago de la factura N.º ${result.inv.number}`, [
      `Gracias. El pago de ${money(result.inv.amountCop)} quedó registrado y tu suscripción está al día hasta el ${day(result.end)}.`,
      ...(result.wasSuspended ? ['La cuenta ya salió del modo de solo lectura.'] : []),
    ]);
    return true;
  }

  // ───────────── Mercado Pago ─────────────

  async startMercadoPago(invoiceId: string) {
    if (!this.mp.enabled) throw new BadRequestException('El pago en línea no está configurado. Usa la transferencia');
    const inv = await this.openInvoiceOfCurrentOrg(invoiceId);
    if (inv.status !== 'pending') throw new ConflictException('Esta factura ya tiene una transferencia en revisión');
    const user = await this.prisma.platform.user.findUnique({ where: { id: currentContext().userId! }, select: { email: true } });
    const { url: tenantUrl } = await orgPublicUrl(this.prisma, inv.organizationId);
    const apiPublic = process.env.API_PUBLIC_URL;
    const pref = await this.mp.createPreference({
      invoiceId: inv.id,
      title: `AguaMata · Factura N.º ${inv.number} · ${inv.organization.name}`.slice(0, 250),
      amountCop: inv.amountCop,
      payerEmail: user?.email,
      notificationUrl: apiPublic && !/localhost|127\.0\.0\.1/.test(apiPublic) ? `${apiPublic}/api/v1/public/payments/mercadopago/webhook` : undefined,
      backUrl: `${tenantUrl}/suscripcion?factura=${inv.id}`,
    });
    // El pago se registra cuando Mercado Pago lo informa (webhook o regreso), no al abrir el checkout.
    await this.audit.log({ action: 'saas.mercadopago_started', entity: 'saas_invoice', entityId: inv.id, data: { preferenceId: pref.id } });
    return { url: pref.url };
  }

  /** Webhook o regreso desde Mercado Pago: se consulta el pago en su API y solo entonces se registra. */
  async processMercadoPagoPayment(paymentId: string, expectedInvoiceId?: string) {
    const p = await this.mp.getPayment(paymentId);
    if (!p || !p.externalReference) return { status: 'ignored' as const };
    if (expectedInvoiceId && p.externalReference !== expectedInvoiceId) throw new BadRequestException('El pago no corresponde a esta factura');
    const inv = await this.prisma.platform.saasInvoice.findUnique({ where: { id: p.externalReference } });
    if (!inv) return { status: 'ignored' as const };

    const valid = p.currency === 'COP' && p.amount >= inv.amountCop;
    const status = p.status === 'approved' && valid ? 'approved' : p.status === 'approved' ? 'rejected' : ['rejected', 'cancelled', 'refunded', 'charged_back'].includes(p.status) ? 'rejected' : 'pending';
    const data = {
      status, providerStatus: p.status, amountCop: Math.round(p.amount), paidAt: p.dateApproved ? new Date(p.dateApproved) : null,
      reference: p.methodId ?? null, rejectReason: p.status === 'approved' && !valid ? `Monto o moneda no coinciden (${p.amount} ${p.currency})` : null,
    };
    await this.prisma.platform.saasPayment.upsert({
      where: { providerPaymentId: p.id },
      create: { invoiceId: inv.id, organizationId: inv.organizationId, method: 'mercadopago', providerPaymentId: p.id, ...data },
      update: data,
    });
    if (status === 'approved') await this.confirmPaid(inv.id, { method: 'mercadopago', reference: `MP ${p.id}`, paidAt: data.paidAt ?? undefined });
    if (p.status === 'approved' && !valid) this.log.warn(`Pago MP ${p.id} aprobado con monto/moneda distintos a la factura ${inv.id}`);
    return { status, invoiceStatus: (await this.prisma.platform.saasInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status };
  }

  /** Al volver de Mercado Pago (no depende del webhook, que en desarrollo no llega). */
  async syncMercadoPago(invoiceId: string, paymentId: string) {
    await this.openOrPaidInvoiceOfCurrentOrg(invoiceId);
    return this.processMercadoPagoPayment(paymentId, invoiceId);
  }

  // ───────────── Transferencia ─────────────

  async reportTransfer(invoiceId: string, file: Express.Multer.File | undefined, input: z.infer<typeof reportTransferSchema>) {
    const inv = await this.openInvoiceOfCurrentOrg(invoiceId);
    if (inv.status === 'in_review') throw new ConflictException('Ya hay una transferencia en revisión para esta factura');
    if (!file) throw new BadRequestException('Adjunta el comprobante de la transferencia');
    if (file.size > MAX_PROOF_BYTES) throw new BadRequestException('El comprobante no puede pesar más de 5 MB');
    const type = PROOF_TYPES[file.mimetype];
    if (!type || !type.magic.every((b, i) => file.buffer[i] === b)) throw new BadRequestException('El comprobante debe ser una imagen PNG o JPG, o un PDF');

    const key = this.storage.orgKey(inv.organizationId, 'saas', 'proofs', `${randomUUID()}.${type.ext}`);
    await this.storage.put(key, file.buffer, file.mimetype);
    const payment = await this.prisma.platform.$transaction(async (tx) => {
      const claimed = await tx.saasInvoice.updateMany({ where: { id: inv.id, status: 'pending' }, data: { status: 'in_review' } });
      if (claimed.count !== 1) throw new ConflictException('La factura cambió de estado. Recarga la página');
      return tx.saasPayment.create({
        data: {
          invoiceId: inv.id, organizationId: inv.organizationId, method: 'transfer', status: 'in_review', amountCop: inv.amountCop,
          reference: input.reference, paidAt: new Date(`${input.paidAt}T12:00:00Z`), notes: input.notes, proofKey: key, proofType: file.mimetype,
          createdById: currentContext().userId,
        },
      });
    });
    await this.audit.log({ action: 'saas.transfer_reported', entity: 'saas_payment', entityId: payment.id, data: { invoiceId: inv.id, reference: input.reference } });
    await this.notifyPlatformAdmins(`Transferencia por revisar: ${inv.organization.name}`, [
      `${inv.organization.name} reportó una transferencia de ${money(inv.amountCop)} para la factura N.º ${inv.number} (referencia ${input.reference}).`,
      'Revisa el comprobante y apruébala o recházala.',
    ]);
    return { id: payment.id, status: payment.status };
  }

  async reviewTransfer(paymentId: string, decision: { decision: 'approve' } | { decision: 'reject'; reason: string }) {
    const p = await this.prisma.platform.saasPayment.findUnique({ where: { id: paymentId }, include: { invoice: { include: { organization: true } } } });
    if (!p || p.method !== 'transfer') throw new NotFoundException();
    if (p.status !== 'in_review') throw new ConflictException('Esta transferencia ya fue revisada');
    const reviewer = { reviewedById: currentContext().userId, reviewedAt: new Date() };
    if (decision.decision === 'approve') {
      await this.prisma.platform.saasPayment.update({ where: { id: p.id }, data: { status: 'approved', ...reviewer } });
      await this.confirmPaid(p.invoiceId, { method: 'transfer', reference: p.reference ?? undefined, paidAt: p.paidAt ?? undefined });
      await this.audit.log({ action: 'saas.transfer_approved', entity: 'saas_payment', entityId: p.id, organizationId: p.organizationId });
    } else {
      await this.prisma.platform.$transaction([
        this.prisma.platform.saasPayment.update({ where: { id: p.id }, data: { status: 'rejected', rejectReason: decision.reason, ...reviewer } }),
        this.prisma.platform.saasInvoice.updateMany({ where: { id: p.invoiceId, status: 'in_review' }, data: { status: 'pending' } }),
      ]);
      await this.audit.log({ action: 'saas.transfer_rejected', entity: 'saas_payment', entityId: p.id, organizationId: p.organizationId, data: { reason: decision.reason } });
      await this.notifyOrg(p.organizationId, `No pudimos aprobar tu transferencia (factura N.º ${p.invoice.number})`, [
        `Revisamos la transferencia reportada para la factura N.º ${p.invoice.number} y no la pudimos aprobar: ${decision.reason}`,
        'Puedes reportarla de nuevo con el comprobante correcto o pagar con Mercado Pago.',
      ]);
    }
    return { ok: true };
  }

  /** Comprobante de una transferencia: el acueducto solo ve los suyos; el superadmin, todos. */
  async proof(paymentId: string, scope: { organizationId?: string }) {
    const p = await this.prisma.platform.saasPayment.findFirst({ where: { id: paymentId, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) } });
    if (!p?.proofKey || !p.proofType) throw new NotFoundException();
    const data = await this.storage.get(p.proofKey);
    if (!data) throw new NotFoundException('El archivo ya no está disponible');
    return { data, type: p.proofType, name: `comprobante-${p.id.slice(0, 8)}.${PROOF_TYPES[p.proofType]?.ext ?? 'bin'}` };
  }

  // ───────────── Superadmin ─────────────

  async recordManualPayment(invoiceId: string, input: z.infer<typeof manualPaymentSchema>) {
    const inv = await this.prisma.platform.saasInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException();
    if (!OPEN_INVOICE.includes(inv.status)) throw new ConflictException('La factura no está pendiente');
    await this.prisma.platform.saasPayment.create({
      data: {
        invoiceId: inv.id, organizationId: inv.organizationId, method: input.method, status: 'approved', amountCop: inv.amountCop, reference: input.reference,
        notes: input.notes, paidAt: new Date(), reviewedById: currentContext().userId, reviewedAt: new Date(), createdById: currentContext().userId,
      },
    });
    // Si había una transferencia en revisión, queda resuelta por este registro.
    await this.prisma.platform.saasPayment.updateMany({ where: { invoiceId: inv.id, status: 'in_review' }, data: { status: 'approved', reviewedById: currentContext().userId, reviewedAt: new Date() } });
    await this.confirmPaid(inv.id, { method: input.method, reference: input.reference });
    return { ok: true };
  }

  async voidInvoice(invoiceId: string, reason: string) {
    const res = await this.prisma.platform.saasInvoice.updateMany({ where: { id: invoiceId, status: { in: OPEN_INVOICE } }, data: { status: 'void', voidedAt: new Date(), voidReason: reason } });
    if (res.count !== 1) throw new ConflictException('Solo se puede anular una factura pendiente');
    await this.prisma.platform.saasPayment.updateMany({ where: { invoiceId, status: { in: ['pending', 'in_review'] } }, data: { status: 'rejected', rejectReason: 'Factura anulada' } });
    const inv = await this.prisma.platform.saasInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    await this.audit.log({ action: 'saas.invoice_voided', entity: 'saas_invoice', entityId: invoiceId, organizationId: inv.organizationId, data: { reason } });
    return { ok: true };
  }

  /** Cambiar el ciclo o la fecha de corte (cortesía / activación manual). Mover la fecha al futuro reactiva la cuenta. */
  async adjustSubscription(organizationId: string, input: z.infer<typeof adjustSubscriptionSchema>) {
    const sub = await this.prisma.platform.subscription.findFirst({ where: { organizationId }, orderBy: { createdAt: 'desc' } });
    if (!sub) throw new NotFoundException('El acueducto no tiene suscripción');
    const data: Prisma.SubscriptionUpdateInput = {};
    if (input.billingCycle) data.billingCycle = input.billingCycle;
    if (input.currentPeriodEnd) {
      const end = new Date(`${input.currentPeriodEnd}T23:59:59-05:00`);
      if (end.getTime() <= Date.now()) throw new BadRequestException('La nueva fecha de corte debe ser futura');
      data.currentPeriodEnd = end;
      data.graceEndsAt = null;
      data.status = sub.status === 'trialing' ? 'trialing' : 'active';
      // Las facturas abiertas del período anterior quedan sin efecto: la próxima se emite según la nueva fecha.
      await this.prisma.platform.saasInvoice.updateMany({ where: { subscriptionId: sub.id, status: 'pending' }, data: { status: 'void', voidedAt: new Date(), voidReason: `Ajuste manual: ${input.reason}` } });
    }
    const updated = await this.prisma.platform.subscription.update({ where: { id: sub.id }, data });
    await this.audit.log({
      action: 'saas.subscription_adjusted', entity: 'subscription', entityId: sub.id, organizationId,
      data: { reason: input.reason, from: { status: sub.status, billingCycle: sub.billingCycle, currentPeriodEnd: sub.currentPeriodEnd.toISOString() }, to: { ...input } },
    });
    return updated;
  }

  async adminOverview() {
    const [plan, settings, pendingTransfers, invoices, counts] = await Promise.all([
      this.defaultPlan(),
      this.settings(),
      this.prisma.platform.saasPayment.findMany({
        where: { method: 'transfer', status: 'in_review' },
        orderBy: { createdAt: 'asc' },
        include: { invoice: { select: { number: true, amountCop: true, periodStart: true, periodEnd: true } }, organization: { select: { name: true, nit: true, nitDv: true } } },
      }),
      this.prisma.platform.saasInvoice.findMany({
        orderBy: { number: 'desc' }, take: 200,
        include: { organization: { select: { id: true, name: true } } },
      }),
      this.prisma.platform.subscription.groupBy({ by: ['status'], _count: true }),
    ]);
    return {
      plan, settings, mercadoPagoEnabled: this.mp.enabled,
      subscriptionCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      pendingTransfers: pendingTransfers.map(({ proofKey, ...p }) => ({ ...p, hasProof: Boolean(proofKey) })),
      invoices,
    };
  }

  // ───────────── Vista del acueducto ─────────────

  async tenantOverview() {
    const organizationId = currentContext().organizationId!;
    const [sub, invoices, payments, settings] = await Promise.all([
      this.prisma.platform.subscription.findFirst({ where: { organizationId }, orderBy: { createdAt: 'desc' }, include: { plan: true } }),
      this.prisma.platform.saasInvoice.findMany({ where: { organizationId }, orderBy: { number: 'desc' }, take: 36 }),
      this.prisma.platform.saasPayment.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.settings(),
    ]);
    const bankReady = Boolean(settings.bank.accountNumber && settings.bank.bankName);
    return {
      subscription: sub && {
        status: sub.status, billingCycle: sub.billingCycle, trialEndsAt: sub.trialEndsAt, currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd, graceEndsAt: sub.graceEndsAt,
        plan: { name: sub.plan.name, priceMonthlyCop: sub.plan.priceMonthlyCop, priceYearlyCop: sub.plan.priceYearlyCop },
      },
      invoices,
      payments: payments.map(({ proofKey, ...p }) => ({ ...p, hasProof: Boolean(proofKey) })),
      payWith: { mercadoPago: this.mp.enabled, transfer: bankReady },
      bank: bankReady ? settings.bank : null,
    };
  }

  /** Estado de la suscripción para el TenantGuard (solo lectura si está suspendida). */
  async accessMode(organizationId: string): Promise<'full' | 'read_only'> {
    const sub = await this.prisma.platform.subscription.findFirst({ where: { organizationId }, orderBy: { createdAt: 'desc' }, select: { status: true } });
    return !sub || sub.status === 'suspended' || sub.status === 'cancelled' ? 'read_only' : 'full';
  }

  private async openInvoiceOfCurrentOrg(invoiceId: string): Promise<InvoiceWithOrg> {
    const inv = await this.openOrPaidInvoiceOfCurrentOrg(invoiceId);
    if (!OPEN_INVOICE.includes(inv.status)) throw new ConflictException('Esta factura ya no está pendiente');
    return inv;
  }

  private async openOrPaidInvoiceOfCurrentOrg(invoiceId: string): Promise<InvoiceWithOrg> {
    const inv = await this.prisma.platform.saasInvoice.findFirst({
      where: { id: invoiceId, organizationId: currentContext().organizationId },
      include: { organization: true, subscription: true },
    });
    if (!inv) throw new NotFoundException();
    return inv;
  }

  // ───────────── Avisos por correo ─────────────

  private async notifyOrg(organizationId: string, subject: string, paragraphs: string[]) {
    try {
      const members = await this.prisma.platform.membership.findMany({
        where: { organizationId, status: 'active', role: { in: ['owner', 'admin'] } }, include: { user: { select: { email: true } } },
      });
      const { org, url } = await orgPublicUrl(this.prisma, organizationId);
      for (const m of members) {
        await this.mail.send({
          to: m.user.email, subject, text: `${paragraphs.join('\n\n')}\n\n${url}/suscripcion`,
          html: emailLayout({ orgName: 'AguaMata', title: subject, paragraphs, cta: { label: 'Ver mi suscripción', url: `${url}/suscripcion` } }),
        });
      }
      void org;
    } catch (e: any) {
      this.log.error(`No se pudo avisar al acueducto ${organizationId}: ${e?.message ?? e}`);
    }
  }

  private async notifyPlatformAdmins(subject: string, paragraphs: string[]) {
    try {
      const admins = await this.prisma.platform.user.findMany({ where: { isPlatformAdmin: true }, select: { email: true } });
      const url = `${platformOrigin()}/admin/cobros`;
      for (const a of admins) {
        await this.mail.send({
          to: a.email, subject, text: `${paragraphs.join('\n\n')}\n\n${url}`,
          html: emailLayout({ orgName: 'AguaMata', title: subject, paragraphs, cta: { label: 'Revisar', url } }),
        });
      }
    } catch (e: any) {
      this.log.error(`No se pudo avisar a los superadmin: ${e?.message ?? e}`);
    }
  }
}
