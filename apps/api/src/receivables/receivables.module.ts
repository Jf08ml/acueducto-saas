import {
  BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  AGING_BUCKETS, AgingBucket, agingBucket, allocateFifo, createPaymentSchema, CreatePaymentInput, daysPastDue,
  parsePaymentReference, voidPaymentSchema,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';

const n = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d));
const r2 = (x: number) => Math.round(x * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const today = () => ymd(new Date());
export const OPEN_STATUSES = ['issued', 'partial'];

/**
 * Serializa las operaciones de dinero de UN acueducto dentro de la transacción (pagos, anulaciones,
 * anulación de facturación). Evita que dos cajeros apliquen dos veces la misma deuda o repitan número.
 */
export async function lockMoney(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId} || ':money'))`;
}

function invoiceView(i: { id: string; number: number; period: string; dueDate: Date; issueDate: Date; total: Prisma.Decimal; paidAmount: Prisma.Decimal; status: string }, asOf: string) {
  const outstanding = r2(n(i.total) - n(i.paidAmount));
  const due = ymd(i.dueDate);
  return {
    id: i.id, number: i.number, period: i.period, issueDate: ymd(i.issueDate), dueDate: due, status: i.status,
    total: n(i.total), paidAmount: n(i.paidAmount), outstanding,
    daysPastDue: outstanding > 0 ? daysPastDue(due, asOf) : 0,
    bucket: agingBucket(due, asOf),
  };
}

// ───────────────────────────── Recaudo ─────────────────────────────

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /** Busca al suscriptor por referencia de pago (código-número), código, documento o nombre. */
  async lookup(q: string) {
    const term = q.trim();
    if (term.length < 1) return [];
    const ref = parsePaymentReference(term);
    if (ref) {
      const inv = await this.prisma.tenant.invoice.findFirst({ where: { number: ref.number }, include: { subscriber: true } });
      if (inv && inv.subscriber.code === ref.code) return [await this.statement(inv.subscriberId)];
    }
    const subs = await this.prisma.tenant.subscriber.findMany({
      where: {
        OR: [
          { code: term },
          { documentNumber: term },
          { fullName: { contains: term, mode: 'insensitive' } },
          { code: { startsWith: term } },
        ],
      },
      orderBy: { code: 'asc' },
      take: 8,
    });
    return Promise.all(subs.map((s) => this.statement(s.id, 5)));
  }

  /** Estado de cuenta: facturas con saldo, pagos y deuda total. */
  async statement(subscriberId: string, paymentsTake = 50) {
    const asOf = today();
    const subscriber = await this.prisma.tenant.subscriber.findUnique({ where: { id: subscriberId } });
    if (!subscriber) throw new NotFoundException('Suscriptor no encontrado');
    const [invoices, payments] = await Promise.all([
      this.prisma.tenant.invoice.findMany({
        where: { subscriberId, status: { not: 'void' } },
        orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
      }),
      this.prisma.tenant.payment.findMany({
        where: { subscriberId },
        orderBy: [{ paidAt: 'desc' }, { number: 'desc' }],
        take: paymentsTake,
        include: { allocations: { include: { invoice: { select: { number: true, period: true } } } } },
      }),
    ]);
    const views = invoices.map((i) => invoiceView(i, asOf));
    const open = views.filter((v) => v.outstanding > 0);
    return {
      subscriber: { id: subscriber.id, code: subscriber.code, fullName: subscriber.fullName, documentNumber: subscriber.documentNumber, address: subscriber.address, status: subscriber.status },
      balance: r2(open.reduce((a, v) => a + v.outstanding, 0)),
      overdueInvoices: open.filter((v) => v.daysPastDue > 0).length,
      openInvoices: open,
      invoices: views.reverse(),
      payments: payments.map((p) => ({
        id: p.id, number: p.number, paidAt: ymd(p.paidAt), amount: n(p.amount), method: p.method, reference: p.reference, status: p.status,
        voidReason: p.voidReason, allocations: p.allocations.map((a) => ({ invoiceNumber: a.invoice.number, period: a.invoice.period, amount: n(a.amount) })),
      })),
    };
  }

  async create(input: CreatePaymentInput) {
    const { organizationId, userId } = currentContext();
    await this.entitlements.assertFeature(organizationId!, 'payments');
    if (input.paidAt > today()) throw new BadRequestException('La fecha del pago no puede ser futura');

    const result = await this.prisma.tenantTransaction(async (tx) => {
      await lockMoney(tx, organizationId!);
      const subscriber = await tx.subscriber.findUnique({ where: { id: input.subscriberId } });
      if (!subscriber) throw new NotFoundException('Suscriptor no encontrado');

      const open = await tx.invoice.findMany({
        where: { subscriberId: subscriber.id, status: { in: OPEN_STATUSES } },
        orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
      });
      const debt = r2(open.reduce((a, i) => a + n(i.total) - n(i.paidAmount), 0));
      if (debt <= 0) throw new BadRequestException('El suscriptor no tiene saldo pendiente');
      const { allocations, remainder } = allocateFifo(open.map((i) => ({ id: i.id, outstanding: n(i.total) - n(i.paidAmount) })), input.amount);
      if (remainder > 0) {
        throw new BadRequestException(`El pago supera la deuda del suscriptor (${debt.toLocaleString('es-CO')}). Por ahora no se reciben anticipos`);
      }

      const last = await tx.payment.aggregate({ _max: { number: true } });
      const payment = await tx.payment.create({
        data: {
          organizationId: organizationId!, subscriberId: subscriber.id, number: (last._max.number ?? 0) + 1,
          paidAt: new Date(input.paidAt), amount: input.amount, method: input.method, reference: input.reference, notes: input.notes,
          receivedById: userId ?? null,
        },
      });
      await tx.paymentAllocation.createMany({
        data: allocations.map((a) => ({ organizationId: organizationId!, paymentId: payment.id, invoiceId: a.invoiceId, amount: a.amount })),
      });
      for (const a of allocations) {
        const inv = open.find((i) => i.id === a.invoiceId)!;
        const paid = r2(n(inv.paidAmount) + a.amount);
        await tx.invoice.update({ where: { id: inv.id }, data: { paidAmount: paid, status: paid >= n(inv.total) ? 'paid' : 'partial' } });
      }
      return { payment, allocations, balanceAfter: r2(debt - input.amount) };
    });

    await this.audit.log({
      action: 'payment.created', entity: 'payment', entityId: result.payment.id,
      data: { number: result.payment.number, amount: input.amount, method: input.method, invoices: result.allocations.length },
    });
    return { id: result.payment.id, number: result.payment.number, allocations: result.allocations, balanceAfter: result.balanceAfter };
  }

  async void(id: string, reason: string) {
    const { organizationId } = currentContext();
    await this.prisma.tenantTransaction(async (tx) => {
      await lockMoney(tx, organizationId!);
      const p = await tx.payment.findUnique({ where: { id }, include: { allocations: true } });
      if (!p) throw new NotFoundException();
      if (p.status === 'void') throw new BadRequestException('El pago ya está anulado');
      for (const a of p.allocations) {
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } });
        const paid = r2(n(inv.paidAmount) - n(a.amount));
        await tx.invoice.update({ where: { id: inv.id }, data: { paidAmount: paid, status: paid <= 0 ? 'issued' : 'partial' } });
      }
      await tx.payment.update({ where: { id }, data: { status: 'void', voidedAt: new Date(), voidReason: reason } });
    });
    await this.audit.log({ action: 'payment.voided', entity: 'payment', entityId: id, data: { reason } });
    return { ok: true };
  }

  /** Caja: pagos de un rango de fechas con totales por medio de pago. */
  async list(from: string, to: string) {
    const payments = await this.prisma.tenant.payment.findMany({
      where: { paidAt: { gte: new Date(from), lte: new Date(to) } },
      orderBy: [{ paidAt: 'desc' }, { number: 'desc' }],
      include: { subscriber: { select: { code: true, fullName: true } } },
      take: 2000,
    });
    const applied = payments.filter((p) => p.status === 'applied');
    const byMethod: Record<string, number> = {};
    for (const p of applied) byMethod[p.method] = r2((byMethod[p.method] ?? 0) + n(p.amount));
    return {
      from, to,
      total: r2(applied.reduce((a, p) => a + n(p.amount), 0)),
      count: applied.length,
      byMethod,
      payments: payments.map((p) => ({
        id: p.id, number: p.number, paidAt: ymd(p.paidAt), amount: n(p.amount), method: p.method, reference: p.reference,
        status: p.status, subscriber: p.subscriber,
      })),
    };
  }

  /** Comprobante de pago. */
  async receipt(id: string) {
    const p = await this.prisma.tenant.payment.findUnique({
      where: { id },
      include: { subscriber: true, allocations: { include: { invoice: { select: { number: true, period: true, total: true } } } } },
    });
    if (!p) throw new NotFoundException();
    const org = await this.prisma.platform.organization.findUniqueOrThrow({ where: { id: currentContext().organizationId! } });
    const b = org.branding as { primaryColor?: string; receiptFooter?: string; logoKey?: string };
    const statement = await this.statement(p.subscriberId, 0);
    return {
      issuer: {
        id: org.id, name: org.name, legalName: org.legalName, nit: `${org.nit}-${org.nitDv}`, municipality: org.municipality, department: org.department,
        contactPhone: org.contactPhone, contactEmail: org.contactEmail, branding: { primaryColor: b.primaryColor, receiptFooter: b.receiptFooter, hasLogo: Boolean(b.logoKey) },
      },
      payment: {
        id: p.id, number: p.number, paidAt: ymd(p.paidAt), amount: n(p.amount), method: p.method, reference: p.reference, notes: p.notes,
        status: p.status, voidReason: p.voidReason, createdAt: p.createdAt,
        subscriber: { code: p.subscriber.code, fullName: p.subscriber.fullName, documentNumber: p.subscriber.documentNumber, address: p.subscriber.address },
        allocations: p.allocations.map((a) => ({ invoiceNumber: a.invoice.number, period: a.invoice.period, amount: n(a.amount) })),
      },
      balanceNow: statement.balance,
    };
  }
}

// ───────────────────────────── Cartera ─────────────────────────────

@Injectable()
export class ReceivablesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cartera por suscriptor a la fecha de corte. `minOverdue` define cuántas facturas vencidas
   * marcan al suscriptor como candidato a suspensión.
   */
  async report(asOf: string, minOverdue: number) {
    const open = await this.prisma.tenant.invoice.findMany({
      where: { status: { in: OPEN_STATUSES } },
      include: { subscriber: { select: { id: true, code: true, fullName: true, address: true, status: true } } },
      orderBy: { dueDate: 'asc' },
    });
    const empty = () => Object.fromEntries(AGING_BUCKETS.map(([k]) => [k, 0])) as Record<AgingBucket, number>;
    const totals = empty();
    const bySub = new Map<string, { subscriber: (typeof open)[number]['subscriber']; balance: number; buckets: Record<AgingBucket, number>; overdueInvoices: number; oldestDue: string; maxDaysPastDue: number }>();

    for (const i of open) {
      const v = invoiceView(i, asOf);
      if (v.outstanding <= 0) continue;
      totals[v.bucket] = r2(totals[v.bucket] + v.outstanding);
      const row = bySub.get(i.subscriberId) ?? { subscriber: i.subscriber, balance: 0, buckets: empty(), overdueInvoices: 0, oldestDue: v.dueDate, maxDaysPastDue: 0 };
      row.balance = r2(row.balance + v.outstanding);
      row.buckets[v.bucket] = r2(row.buckets[v.bucket] + v.outstanding);
      if (v.daysPastDue > 0) row.overdueInvoices++;
      row.maxDaysPastDue = Math.max(row.maxDaysPastDue, v.daysPastDue);
      if (v.dueDate < row.oldestDue) row.oldestDue = v.dueDate;
      bySub.set(i.subscriberId, row);
    }

    const rows = [...bySub.values()]
      .map((r) => ({ ...r, suspensionCandidate: r.overdueInvoices >= minOverdue }))
      .sort((a, b) => b.maxDaysPastDue - a.maxDaysPastDue || b.balance - a.balance);
    const total = r2(Object.values(totals).reduce((a, b) => a + b, 0));
    return {
      asOf, minOverdue, total, buckets: totals,
      overdue: r2(total - totals.current),
      subscribersWithDebt: rows.length,
      suspensionCandidates: rows.filter((r) => r.suspensionCandidate).length,
      rows,
    };
  }
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

@Controller('payments')
@TenantScoped()
class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@Query('from') from?: string, @Query('to') to?: string) {
    const f = dateSchema.safeParse(from).success ? from! : today();
    const t = dateSchema.safeParse(to).success ? to! : f;
    return this.payments.list(f, t);
  }

  @Get('lookup')
  lookup(@Query('q') q = '') {
    return this.payments.lookup(q);
  }

  @Get('statement/:subscriberId')
  statement(@Param('subscriberId', ParseUUIDPipe) id: string) {
    return this.payments.statement(id);
  }

  @Get(':id')
  receipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.receipt(id);
  }

  @Post()
  @TenantScoped('owner', 'admin', 'operator')
  create(@Body(new ZodPipe(createPaymentSchema)) body: CreatePaymentInput) {
    return this.payments.create(body);
  }

  @Post(':id/void')
  @TenantScoped('owner', 'admin')
  void(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidPaymentSchema)) body: z.infer<typeof voidPaymentSchema>) {
    return this.payments.void(id, body.reason);
  }
}

@Controller('receivables')
@TenantScoped()
class ReceivablesController {
  constructor(private readonly receivables: ReceivablesService) {}

  @Get()
  report(@Query('asOf') asOf?: string, @Query('minOverdue') minOverdue?: string) {
    const d = dateSchema.safeParse(asOf).success ? asOf! : today();
    const m = Math.min(12, Math.max(1, Number(minOverdue) || 2));
    return this.receivables.report(d, m);
  }
}

@Module({ controllers: [PaymentsController, ReceivablesController], providers: [PaymentsService, ReceivablesService], exports: [ReceivablesService] })
export class ReceivablesModule {}
