import {
  BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch,
  Post, Query,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  computeConsumption, createMeterSchema, CreateMeterInput, meterStatusSchema, periodSchema, saveReadingsSchema, SaveReadingsInput,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';

const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));

// ───────────────────────────── Medidores ─────────────────────────────

@Injectable()
export class MetersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  list(subscriberId?: string, status?: string) {
    return this.prisma.tenant.meter.findMany({
      where: { ...(subscriberId ? { subscriberId } : {}), ...(status ? { status } : {}) },
      include: { subscriber: { select: { id: true, code: true, fullName: true, address: true } } },
      orderBy: [{ subscriber: { code: 'asc' } }, { installedAt: 'desc' }],
      take: 2000,
    });
  }

  async create(input: CreateMeterInput) {
    const organizationId = currentContext().organizationId!;
    await this.entitlements.assertFeature(organizationId, 'meters');
    // Búsqueda con RLS: un suscriptor de otro acueducto simplemente "no existe".
    const subscriber = await this.prisma.tenant.subscriber.findUnique({ where: { id: input.subscriberId } });
    if (!subscriber) throw new NotFoundException('Suscriptor no encontrado');
    if (await this.prisma.tenant.meter.findFirst({ where: { subscriberId: subscriber.id, status: 'active' } })) {
      throw new ConflictException('El suscriptor ya tiene un medidor activo. Retíralo antes de instalar otro');
    }
    try {
      const m = await this.prisma.tenant.meter.create({
        data: { ...input, organizationId, installedAt: new Date(input.installedAt) },
      });
      await this.audit.log({ action: 'meter.installed', entity: 'meter', entityId: m.id, data: { serial: m.serial, subscriber: subscriber.code } });
      return m;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ya existe un medidor con ese serial');
      }
      throw e;
    }
  }

  async setStatus(id: string, input: z.infer<typeof meterStatusSchema>) {
    const m = await this.prisma.tenant.meter.findUnique({ where: { id } });
    if (!m) throw new NotFoundException();
    if (input.status === 'active' && m.status !== 'active') {
      const other = await this.prisma.tenant.meter.findFirst({ where: { subscriberId: m.subscriberId, status: 'active' } });
      if (other) throw new ConflictException('El suscriptor ya tiene otro medidor activo');
    }
    const updated = await this.prisma.tenant.meter.update({
      where: { id },
      data: {
        status: input.status,
        removedAt: input.status === 'removed' ? new Date(input.date) : null,
        notes: input.notes ?? m.notes,
      },
    });
    await this.audit.log({ action: `meter.${input.status}`, entity: 'meter', entityId: id });
    return updated;
  }
}

// ───────────────────────────── Lecturas ─────────────────────────────

@Injectable()
export class ReadingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Historial de lecturas previas a `period` agrupado por medidor (más reciente primero). */
  private async history(meterIds: string[], period: string) {
    const prior = await this.prisma.tenant.meterReading.findMany({
      where: { meterId: { in: meterIds }, period: { lt: period } },
      orderBy: { period: 'desc' },
      select: { meterId: true, period: true, value: true, consumptionM3: true, anomaly: true },
    });
    const byMeter = new Map<string, typeof prior>();
    for (const r of prior) {
      const list = byMeter.get(r.meterId) ?? [];
      if (list.length < 12) list.push(r);
      byMeter.set(r.meterId, list);
    }
    return byMeter;
  }

  /** Lectura anterior = último valor realmente leído; si nunca se ha leído, la lectura inicial del medidor. */
  private previousOf(meter: { initialReading: Prisma.Decimal }, prior: { value: Prisma.Decimal | null }[] = []) {
    const lastRead = prior.find((r) => r.value !== null);
    return lastRead ? Number(lastRead.value) : Number(meter.initialReading);
  }

  private consumptionHistory(prior: { consumptionM3: Prisma.Decimal; anomaly: string | null }[] = []) {
    return prior.filter((r) => r.anomaly !== 'negative' && r.anomaly !== 'estimated').map((r) => Number(r.consumptionM3));
  }

  /** Planilla de lectura del período: un renglón por medidor activo, en orden de código de suscriptor. */
  async sheet(period: string) {
    const meters = await this.prisma.tenant.meter.findMany({
      where: { status: 'active' },
      include: { subscriber: { select: { id: true, code: true, fullName: true, address: true } } },
      orderBy: { subscriber: { code: 'asc' } },
    });
    const ids = meters.map((m) => m.id);
    const [byMeter, current] = await Promise.all([
      this.history(ids, period),
      this.prisma.tenant.meterReading.findMany({ where: { period, meterId: { in: ids } } }),
    ]);
    const currentBy = new Map(current.map((r) => [r.meterId, r]));

    return meters.map((m) => {
      const prior = byMeter.get(m.id);
      const hist = this.consumptionHistory(prior);
      const r = currentBy.get(m.id);
      return {
        meterId: m.id,
        serial: m.serial,
        subscriber: m.subscriber,
        previousValue: this.previousOf(m, prior),
        averageM3: hist.length ? Math.round((hist.slice(0, 6).reduce((a, b) => a + b, 0) / Math.min(hist.length, 6)) * 100) / 100 : null,
        reading: r
          ? { id: r.id, value: num(r.value), consumptionM3: Number(r.consumptionM3), isEstimated: r.isEstimated, anomaly: r.anomaly, observation: r.observation, locked: r.locked }
          : null,
      };
    });
  }

  async save(input: SaveReadingsInput) {
    const { organizationId, userId } = currentContext();
    const ids = [...new Set(input.entries.map((e) => e.meterId))];
    if (ids.length !== input.entries.length) throw new BadRequestException('Hay medidores repetidos en el envío');

    const meters = await this.prisma.tenant.meter.findMany({ where: { id: { in: ids } } });
    const meterBy = new Map(meters.map((m) => [m.id, m]));
    const [byMeter, existing, later] = await Promise.all([
      this.history(ids, input.period),
      this.prisma.tenant.meterReading.findMany({ where: { period: input.period, meterId: { in: ids } } }),
      this.prisma.tenant.meterReading.findMany({ where: { period: { gt: input.period }, meterId: { in: ids } }, select: { meterId: true } }),
    ]);
    const existingBy = new Map(existing.map((r) => [r.meterId, r]));
    const hasLater = new Set(later.map((r) => r.meterId));

    const results: { meterId: string; ok: boolean; error?: string; consumptionM3?: number; anomaly?: string | null; isEstimated?: boolean }[] = [];
    for (const e of input.entries) {
      const meter = meterBy.get(e.meterId);
      if (!meter) { results.push({ meterId: e.meterId, ok: false, error: 'Medidor no encontrado' }); continue; }
      if (meter.status !== 'active') { results.push({ meterId: e.meterId, ok: false, error: 'El medidor no está activo' }); continue; }
      const prev = existingBy.get(e.meterId);
      if (prev?.locked) { results.push({ meterId: e.meterId, ok: false, error: 'El período ya fue facturado' }); continue; }
      if (hasLater.has(e.meterId)) { results.push({ meterId: e.meterId, ok: false, error: 'Ya hay lecturas de períodos posteriores' }); continue; }

      const prior = byMeter.get(e.meterId);
      const previousValue = this.previousOf(meter, prior);
      const c = computeConsumption(previousValue, e.value, this.consumptionHistory(prior));
      const data = {
        readingDate: new Date(input.readingDate),
        value: e.value,
        previousValue,
        consumptionM3: c.consumption,
        isEstimated: c.isEstimated,
        anomaly: c.anomaly,
        observation: e.observation ?? null,
        readerUserId: userId ?? null,
        source: 'manual',
      };
      if (prev) await this.prisma.tenant.meterReading.update({ where: { id: prev.id }, data });
      else {
        await this.prisma.tenant.meterReading.create({
          data: { ...data, organizationId: organizationId!, meterId: meter.id, subscriberId: meter.subscriberId, period: input.period },
        });
      }
      results.push({ meterId: e.meterId, ok: true, consumptionM3: c.consumption, anomaly: c.anomaly, isEstimated: c.isEstimated });
    }

    const saved = results.filter((r) => r.ok).length;
    await this.audit.log({ action: 'readings.saved', entity: 'meter_reading', data: { period: input.period, saved, failed: results.length - saved } });
    return { saved, failed: results.length - saved, results };
  }

  async summary(period: string) {
    const [activeMeters, readings] = await Promise.all([
      this.prisma.tenant.meter.count({ where: { status: 'active' } }),
      this.prisma.tenant.meterReading.groupBy({ by: ['anomaly'], where: { period }, _count: { _all: true }, _sum: { consumptionM3: true } }),
    ]);
    const read = readings.reduce((a, r) => a + r._count._all, 0);
    const anomalies = Object.fromEntries(readings.filter((r) => r.anomaly).map((r) => [r.anomaly!, r._count._all]));
    const totalM3 = readings.reduce((a, r) => a + Number(r._sum.consumptionM3 ?? 0), 0);
    return { period, activeMeters, read, pending: Math.max(activeMeters - read, 0), anomalies, totalM3 };
  }
}

const periodQuery = new ZodPipe(periodSchema);

@Controller('meters')
@TenantScoped()
class MetersController {
  constructor(private readonly meters: MetersService) {}

  @Get()
  list(@Query('subscriberId') subscriberId?: string, @Query('status') status?: string) {
    return this.meters.list(subscriberId, status);
  }

  @Post()
  @TenantScoped('owner', 'admin', 'operator')
  create(@Body(new ZodPipe(createMeterSchema)) body: CreateMeterInput) {
    return this.meters.create(body);
  }

  @Patch(':id/status')
  @TenantScoped('owner', 'admin', 'operator')
  status(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(meterStatusSchema)) body: z.infer<typeof meterStatusSchema>) {
    return this.meters.setStatus(id, body);
  }
}

@Controller('readings')
@TenantScoped()
class ReadingsController {
  constructor(private readonly readings: ReadingsService) {}

  @Get('sheet')
  sheet(@Query('period', periodQuery) period: string) {
    return this.readings.sheet(period);
  }

  @Get('summary')
  summary(@Query('period', periodQuery) period: string) {
    return this.readings.summary(period);
  }

  @Post()
  @TenantScoped('owner', 'admin', 'operator')
  save(@Body(new ZodPipe(saveReadingsSchema)) body: SaveReadingsInput) {
    return this.readings.save(body);
  }
}

// ───────────────────────────── Tablero ─────────────────────────────

@Controller('dashboard')
@TenantScoped()
class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readings: ReadingsService,
  ) {}

  @Get()
  async dashboard(@Query('period', periodQuery) period: string) {
    const [y, m] = period.split('-').map(Number);
    const monthStart = new Date(Date.UTC(y, m - 1, 1));
    const monthEnd = new Date(Date.UTC(y, m, 0));
    const [subscribers, compliancePending, readingSummary, collected, open] = await Promise.all([
      this.prisma.tenant.subscriber.count(),
      this.prisma.tenant.complianceItem.count({ where: { status: { in: ['pending', 'in_progress'] } } }),
      this.readings.summary(period),
      this.prisma.tenant.payment.aggregate({ where: { status: 'applied', paidAt: { gte: monthStart, lte: monthEnd } }, _sum: { amount: true }, _count: true }),
      this.prisma.tenant.invoice.aggregate({ where: { status: { in: ['issued', 'partial'] } }, _sum: { total: true, paidAmount: true } }),
    ]);
    return {
      subscribers,
      compliancePending,
      readings: readingSummary,
      collected: { amount: Number(collected._sum.amount ?? 0), count: collected._count },
      receivables: Math.round((Number(open._sum.total ?? 0) - Number(open._sum.paidAmount ?? 0)) * 100) / 100,
    };
  }
}

@Module({ controllers: [MetersController, ReadingsController, DashboardController], providers: [MetersService, ReadingsService] })
export class MetersModule {}
