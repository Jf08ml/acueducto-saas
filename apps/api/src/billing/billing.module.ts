import {
  BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  BillingOptions, computeInvoice, InvoiceCalc, issueBillingSchema, IssueBillingInput, periodSchema, previewBillingSchema,
  TariffForBilling, voidBillingSchema,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';
import { lockMoney, OPEN_STATUSES } from '../receivables/receivables.module';

const n = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d));

interface DraftInvoice {
  subscriberId: string;
  subscriber: { code: string; fullName: string; documentNumber: string; address: string; stratum: number | null; usage: string };
  reading: {
    meterSerial: string | null; previousValue: number | null; currentValue: number | null; consumptionM3: number;
    isEstimated: boolean; anomaly: string | null; observation: string | null; flag: 'ok' | 'sin_lectura' | 'sin_medidor';
  };
  calc: InvoiceCalc;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  private async activeTariff() {
    const t = await this.prisma.tenant.tariffSchedule.findFirst({ where: { isActive: true }, orderBy: { effectiveFrom: 'desc' } });
    if (!t) throw new BadRequestException('Configura una tarifa vigente antes de facturar');
    const tariff: TariffForBilling = {
      basicConsumptionM3: t.basicConsumptionM3, sumptuaryFromM3: t.sumptuaryFromM3, fixedCharge: n(t.fixedCharge),
      rateBasic: n(t.rateBasic), rateComplementary: n(t.rateComplementary), rateSumptuary: n(t.rateSumptuary),
      stratumFactors: (t.stratumFactors ?? {}) as Record<string, number>,
    };
    return { row: t, tariff };
  }

  /** Arma (sin guardar) las facturas del período. Lo usan la previsualización y la emisión. */
  private async build(period: string, options: BillingOptions) {
    const { row: tariffRow, tariff } = await this.activeTariff();
    const [subscribers, meters, readings] = await Promise.all([
      this.prisma.tenant.subscriber.findMany({ where: { status: 'active' }, orderBy: { code: 'asc' } }),
      this.prisma.tenant.meter.findMany({ where: { status: 'active' } }),
      this.prisma.tenant.meterReading.findMany({ where: { period } }),
    ]);
    const meterBySub = new Map(meters.map((m) => [m.subscriberId, m]));
    const readingByMeter = new Map(readings.map((r) => [r.meterId, r]));

    const drafts: DraftInvoice[] = [];
    const missingReadings: { code: string; fullName: string }[] = [];
    for (const s of subscribers) {
      const meter = meterBySub.get(s.id);
      const reading = meter ? readingByMeter.get(meter.id) : undefined;
      let r: DraftInvoice['reading'];
      if (meter && reading) {
        r = {
          meterSerial: meter.serial, previousValue: n(reading.previousValue), currentValue: reading.value === null ? null : n(reading.value),
          consumptionM3: n(reading.consumptionM3), isEstimated: reading.isEstimated, anomaly: reading.anomaly, observation: reading.observation, flag: 'ok',
        };
      } else if (meter) {
        missingReadings.push({ code: s.code, fullName: s.fullName });
        r = { meterSerial: meter.serial, previousValue: null, currentValue: null, consumptionM3: 0, isEstimated: false, anomaly: null, observation: null, flag: 'sin_lectura' };
      } else {
        r = {
          meterSerial: null, previousValue: null, currentValue: null, consumptionM3: options.unmeteredConsumptionM3 ?? 0,
          isEstimated: true, anomaly: null, observation: 'sin_medidor', flag: 'sin_medidor',
        };
      }
      drafts.push({
        subscriberId: s.id,
        subscriber: { code: s.code, fullName: s.fullName, documentNumber: s.documentNumber, address: s.address, stratum: s.stratum, usage: s.usage },
        reading: r,
        calc: computeInvoice(tariff, { consumptionM3: r.consumptionM3, usage: s.usage, stratum: s.stratum }),
      });
    }

    const totals = drafts.reduce(
      (a, d) => ({
        total: a.total + d.calc.total, subsidy: a.subsidy + d.calc.subsidy, contribution: a.contribution + d.calc.contribution,
        consumptionM3: a.consumptionM3 + d.reading.consumptionM3,
      }),
      { total: 0, subsidy: 0, contribution: 0, consumptionM3: 0 },
    );
    const warnings = {
      missingReadings,
      unmetered: drafts.filter((d) => d.reading.flag === 'sin_medidor').length,
      estimated: drafts.filter((d) => d.reading.isEstimated && d.reading.flag === 'ok').length,
      toReview: drafts.filter((d) => d.reading.anomaly && d.reading.anomaly !== 'estimated').length,
    };
    return { tariffRow, drafts, totals, warnings };
  }

  async preview(period: string, options: BillingOptions) {
    const existing = await this.prisma.tenant.billingPeriod.findUnique({
      where: { organizationId_period: { organizationId: currentContext().organizationId!, period } },
    });
    const { tariffRow, drafts, totals, warnings } = await this.build(period, options);
    return {
      period,
      alreadyIssued: existing?.status === 'issued',
      tariff: { id: tariffRow.id, name: tariffRow.name },
      totals: { ...totals, invoices: drafts.length },
      warnings,
      canIssue: existing?.status !== 'issued' && drafts.length > 0 && (options.missingReadings === 'fixed_only' || warnings.missingReadings.length === 0),
      rows: drafts.map((d) => ({
        subscriberId: d.subscriberId, code: d.subscriber.code, fullName: d.subscriber.fullName, stratum: d.subscriber.stratum, usage: d.subscriber.usage,
        consumptionM3: d.reading.consumptionM3, flag: d.reading.flag, anomaly: d.reading.anomaly, isEstimated: d.reading.isEstimated,
        subtotal: d.calc.subtotal, subsidy: d.calc.subsidy, contribution: d.calc.contribution, total: d.calc.total,
      })),
    };
  }

  /** Emite todas las facturas del período en UNA transacción: o se emiten todas, o ninguna. */
  async issue(input: IssueBillingInput) {
    const { organizationId, userId } = currentContext();
    await this.entitlements.assertFeature(organizationId!, 'billing');

    const existing = await this.prisma.tenant.billingPeriod.findUnique({
      where: { organizationId_period: { organizationId: organizationId!, period: input.period } },
    });
    if (existing?.status === 'issued') throw new ConflictException('Este período ya está facturado. Anúlalo si necesitas volver a emitirlo');

    const { tariffRow, drafts, totals, warnings } = await this.build(input.period, input.options);
    if (!drafts.length) throw new BadRequestException('No hay suscriptores activos para facturar');
    if (input.options.missingReadings === 'block' && warnings.missingReadings.length) {
      throw new BadRequestException({
        code: 'MISSING_READINGS',
        message: `Faltan ${warnings.missingReadings.length} lecturas del período. Regístralas o elige facturar solo el cargo fijo`,
        missing: warnings.missingReadings.slice(0, 50),
      });
    }

    // Historial de consumo (últimos 6 períodos) para el recibo.
    const history = await this.prisma.tenant.meterReading.findMany({
      where: { period: { lt: input.period }, subscriberId: { in: drafts.map((d) => d.subscriberId) } },
      orderBy: { period: 'desc' },
      select: { subscriberId: true, period: true, consumptionM3: true },
    });
    const histBy = new Map<string, { period: string; m3: number }[]>();
    for (const h of history) {
      const list = histBy.get(h.subscriberId) ?? [];
      if (list.length < 6) list.push({ period: h.period, m3: n(h.consumptionM3) });
      histBy.set(h.subscriberId, list);
    }

    const issueDate = new Date(input.issueDate);
    const dueDate = new Date(input.dueDate);
    const result = await this.prisma.tenantTransaction(async (tx) => {
      await lockMoney(tx, organizationId!);
      // Saldo anterior: lo que cada suscriptor debe de facturas previas al momento de emitir (se informa en el recibo).
      const openPrev = await tx.invoice.findMany({
        where: { status: { in: OPEN_STATUSES }, subscriberId: { in: drafts.map((d) => d.subscriberId) } },
        select: { subscriberId: true, total: true, paidAmount: true },
      });
      const prevBy = new Map<string, number>();
      for (const i of openPrev) prevBy.set(i.subscriberId, Math.round(((prevBy.get(i.subscriberId) ?? 0) + n(i.total) - n(i.paidAmount)) * 100) / 100);

      const periodData = {
        status: 'issued', tariffScheduleId: tariffRow.id, issueDate, dueDate, options: input.options as Prisma.InputJsonValue,
        invoiceCount: drafts.length, totalAmount: totals.total, subsidyAmount: totals.subsidy, contributionAmount: totals.contribution,
        consumptionM3: totals.consumptionM3, issuedById: userId ?? null, issuedAt: new Date(), voidedAt: null, voidReason: null,
      };
      const bp = existing
        ? await tx.billingPeriod.update({ where: { id: existing.id }, data: periodData })
        : await tx.billingPeriod.create({ data: { ...periodData, organizationId: organizationId!, period: input.period } });

      // Numeración consecutiva por acueducto. El índice único (organization_id, number) protege contra carreras.
      const last = await tx.invoice.aggregate({ _max: { number: true } });
      let next = (last._max.number ?? 0) + 1;

      const invoices: Prisma.InvoiceCreateManyInput[] = [];
      const lines: Prisma.InvoiceLineCreateManyInput[] = [];
      for (const d of drafts) {
        const id = randomUUID();
        invoices.push({
          id, organizationId: organizationId!, billingPeriodId: bp.id, subscriberId: d.subscriberId, number: next++, period: input.period,
          issueDate, dueDate, subscriberSnapshot: d.subscriber as Prisma.InputJsonValue,
          readingSnapshot: { ...d.reading, history: histBy.get(d.subscriberId) ?? [] } as Prisma.InputJsonValue,
          consumptionM3: d.reading.consumptionM3, subtotal: d.calc.subtotal, subsidyAmount: d.calc.subsidy,
          contributionAmount: d.calc.contribution, total: d.calc.total, previousBalance: prevBy.get(d.subscriberId) ?? 0,
        });
        d.calc.lines.forEach((l, i) =>
          lines.push({ organizationId: organizationId!, invoiceId: id, concept: l.concept, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, sortOrder: i }),
        );
      }
      for (let i = 0; i < invoices.length; i += 1000) await tx.invoice.createMany({ data: invoices.slice(i, i + 1000) });
      for (let i = 0; i < lines.length; i += 5000) await tx.invoiceLine.createMany({ data: lines.slice(i, i + 5000) });
      // Las lecturas facturadas ya no se pueden modificar.
      await tx.meterReading.updateMany({ where: { period: input.period }, data: { locked: true } });
      return { billingPeriodId: bp.id, firstNumber: invoices[0].number, lastNumber: invoices[invoices.length - 1].number };
    });

    await this.audit.log({
      action: 'billing.issued', entity: 'billing_period', entityId: result.billingPeriodId,
      data: { period: input.period, invoices: drafts.length, total: totals.total, numbers: `${result.firstNumber}-${result.lastNumber}` },
    });
    return { ...result, invoices: drafts.length, total: totals.total };
  }

  async voidPeriod(period: string, reason: string) {
    const bp = await this.prisma.tenant.billingPeriod.findUnique({
      where: { organizationId_period: { organizationId: currentContext().organizationId!, period } },
    });
    if (!bp || bp.status !== 'issued') throw new NotFoundException('No hay una facturación emitida para ese período');

    await this.prisma.tenantTransaction(async (tx) => {
      await lockMoney(tx, bp.organizationId);
      // Dentro del bloqueo: ningún pago puede entrar entre esta verificación y la anulación.
      const paid = await tx.invoice.count({ where: { billingPeriodId: bp.id, paidAmount: { gt: 0 } } });
      if (paid) throw new ConflictException(`No se puede anular: ${paid} facturas tienen pagos o abonos. Anula primero esos pagos`);
      await tx.invoice.updateMany({ where: { billingPeriodId: bp.id, status: { not: 'void' } }, data: { status: 'void' } });
      await tx.meterReading.updateMany({ where: { period }, data: { locked: false } });
      await tx.billingPeriod.update({ where: { id: bp.id }, data: { status: 'voided', voidedAt: new Date(), voidReason: reason } });
    });
    await this.audit.log({ action: 'billing.voided', entity: 'billing_period', entityId: bp.id, data: { period, reason } });
    return { ok: true };
  }

  listPeriods() {
    return this.prisma.tenant.billingPeriod.findMany({ orderBy: { period: 'desc' }, take: 60, include: { tariff: { select: { name: true } } } });
  }

  async getPeriod(period: string) {
    const bp = await this.prisma.tenant.billingPeriod.findUnique({
      where: { organizationId_period: { organizationId: currentContext().organizationId!, period } },
      include: { tariff: { select: { name: true } } },
    });
    if (!bp) throw new NotFoundException();
    const invoices = await this.prisma.tenant.invoice.findMany({
      where: { billingPeriodId: bp.id },
      orderBy: { number: 'asc' },
      select: { id: true, number: true, status: true, subscriberSnapshot: true, consumptionM3: true, subsidyAmount: true, contributionAmount: true, total: true },
    });
    return { ...bp, invoices };
  }

  private async issuer() {
    const org = await this.prisma.platform.organization.findUniqueOrThrow({ where: { id: currentContext().organizationId! } });
    const b = org.branding as { primaryColor?: string; secondaryColor?: string; receiptFooter?: string; logoKey?: string };
    return {
      id: org.id, name: org.name, legalName: org.legalName, nit: `${org.nit}-${org.nitDv}`, municipality: org.municipality,
      department: org.department, contactPhone: org.contactPhone, contactEmail: org.contactEmail,
      branding: { primaryColor: b.primaryColor, secondaryColor: b.secondaryColor, receiptFooter: b.receiptFooter, hasLogo: Boolean(b.logoKey) },
    };
  }

  async invoice(id: string) {
    const inv = await this.prisma.tenant.invoice.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
    if (!inv) throw new NotFoundException();
    return { issuer: await this.issuer(), invoices: [inv] };
  }

  /** Todos los recibos de un período, para imprimir en lote. */
  async receipts(period: string) {
    const invoices = await this.prisma.tenant.invoice.findMany({
      where: { period, status: { not: 'void' } },
      orderBy: { number: 'asc' },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
      take: 5000,
    });
    return { issuer: await this.issuer(), invoices };
  }
}

const periodParam = new ZodPipe(periodSchema);

@Controller('billing')
@TenantScoped()
class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('periods')
  list() {
    return this.billing.listPeriods();
  }

  @Get('periods/:period')
  get(@Param('period', periodParam) period: string) {
    return this.billing.getPeriod(period);
  }

  @Get('periods/:period/receipts')
  receipts(@Param('period', periodParam) period: string) {
    return this.billing.receipts(period);
  }

  @Post('preview')
  @TenantScoped('owner', 'admin')
  preview(@Body(new ZodPipe(previewBillingSchema)) body: z.infer<typeof previewBillingSchema>) {
    return this.billing.preview(body.period, body.options);
  }

  @Post('issue')
  @TenantScoped('owner', 'admin')
  issue(@Body(new ZodPipe(issueBillingSchema)) body: IssueBillingInput) {
    return this.billing.issue(body);
  }

  @Post('periods/:period/void')
  @TenantScoped('owner', 'admin')
  void(@Param('period', periodParam) period: string, @Body(new ZodPipe(voidBillingSchema)) body: z.infer<typeof voidBillingSchema>) {
    return this.billing.voidPeriod(period, body.reason);
  }
}

@Controller('invoices')
@TenantScoped()
class InvoicesController {
  constructor(private readonly billing: BillingService) {}

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.invoice(id);
  }
}

@Module({ controllers: [BillingController, InvoicesController], providers: [BillingService] })
export class BillingModule {}
