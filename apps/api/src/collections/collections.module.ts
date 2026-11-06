import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  collectionSettingsSchema, CollectionSettings, createChargeSchema, reconnectSchema, ReconnectInput, suspendSchema, withCollectionDefaults,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';
import { lockMoney, OPEN_STATUSES } from '../common/money';

const n = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d));
const r2 = (x: number) => Math.round(x * 100) / 100;

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private orgId() {
    return currentContext().organizationId!;
  }

  async settings(): Promise<CollectionSettings> {
    const org = await this.prisma.platform.organization.findUniqueOrThrow({ where: { id: this.orgId() }, select: { collectionSettings: true } });
    return withCollectionDefaults(org.collectionSettings);
  }

  async saveSettings(input: CollectionSettings) {
    await this.prisma.platform.organization.update({ where: { id: this.orgId() }, data: { collectionSettings: input as Prisma.InputJsonValue } });
    await this.audit.log({ action: 'collections.settings', entity: 'organization', entityId: this.orgId(), data: input as Prisma.InputJsonValue });
    return input;
  }

  private async balance(tx: Prisma.TransactionClient, subscriberId: string) {
    const open = await tx.invoice.findMany({ where: { subscriberId, status: { in: OPEN_STATUSES } }, select: { total: true, paidAmount: true } });
    return r2(open.reduce((a, i) => a + n(i.total) - n(i.paidAmount), 0));
  }

  // ───── Cargos adicionales ─────

  async charges(subscriberId?: string) {
    const rows = await this.prisma.tenant.subscriberCharge.findMany({
      where: { ...(subscriberId ? { subscriberId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { subscriber: { select: { code: true, fullName: true } }, billedInvoice: { select: { number: true, period: true } } },
      take: 500,
    });
    return rows.map((c) => ({
      id: c.id, concept: c.concept, description: c.description, amount: n(c.amount), createdAt: c.createdAt, subscriber: c.subscriber,
      status: c.voidedAt ? 'void' : c.billedInvoiceId ? 'billed' : 'pending', billedInvoice: c.billedInvoice,
    }));
  }

  async addCharge(input: z.infer<typeof createChargeSchema>) {
    const { userId } = currentContext();
    const s = await this.prisma.tenant.subscriber.findUnique({ where: { id: input.subscriberId } });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');
    const c = await this.prisma.tenant.subscriberCharge.create({
      data: { organizationId: this.orgId(), subscriberId: s.id, concept: 'otro', description: input.description, amount: input.amount, createdById: userId },
    });
    await this.audit.log({ action: 'charge.created', entity: 'subscriber_charge', entityId: c.id, data: { subscriber: s.code, amount: input.amount, description: input.description } });
    return { id: c.id };
  }

  /** Solo se anulan cargos aún no facturados. */
  async voidCharge(id: string) {
    await this.prisma.tenantTransaction(async (tx) => {
      await lockMoney(tx, this.orgId());
      const c = await tx.subscriberCharge.findUnique({ where: { id } });
      if (!c) throw new NotFoundException();
      if (c.billedInvoiceId) throw new BadRequestException('El cargo ya fue facturado; anula la facturación si necesitas corregirlo');
      if (c.voidedAt) throw new BadRequestException('El cargo ya está anulado');
      await tx.subscriberCharge.update({ where: { id }, data: { voidedAt: new Date() } });
    });
    await this.audit.log({ action: 'charge.voided', entity: 'subscriber_charge', entityId: id });
  }

  // ───── Suspensión y reconexión ─────

  async events(subscriberId: string) {
    const s = await this.prisma.tenant.subscriber.findUnique({ where: { id: subscriberId } });
    if (!s) throw new NotFoundException();
    const events = await this.prisma.tenant.serviceEvent.findMany({ where: { subscriberId }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
    return { serviceStatus: s.serviceStatus, events: events.map((e) => ({ ...e, balanceAtEvent: n(e.balanceAtEvent) })) };
  }

  async suspend(subscriberId: string, input: z.infer<typeof suspendSchema>) {
    const { userId } = currentContext();
    const result = await this.prisma.tenantTransaction(async (tx) => {
      await lockMoney(tx, this.orgId());
      const s = await tx.subscriber.findUnique({ where: { id: subscriberId } });
      if (!s) throw new NotFoundException('Suscriptor no encontrado');
      if (s.serviceStatus === 'suspended') throw new BadRequestException('El servicio ya está suspendido');
      const balance = await this.balance(tx, s.id);
      const ev = await tx.serviceEvent.create({
        data: { organizationId: this.orgId(), subscriberId: s.id, type: 'suspension', date: new Date(input.date), reason: input.reason, notes: input.notes, balanceAtEvent: balance, userId },
      });
      await tx.subscriber.update({ where: { id: s.id }, data: { serviceStatus: 'suspended' } });
      return { ev, s, balance };
    });
    await this.audit.log({ action: 'service.suspended', entity: 'subscriber', entityId: subscriberId, data: { code: result.s.code, balance: result.balance, reason: input.reason } });
    return { id: result.ev.id, serviceStatus: 'suspended', balance: result.balance };
  }

  /**
   * Reconexión. Por defecto exige que el suscriptor esté al día (Ley 142, art. 142: eliminar la causa y pagar).
   * Con `allowWithDebt` (p. ej. acuerdo de pago) se permite, dejando el motivo registrado.
   * El cargo de reconexión se suma a la siguiente factura.
   */
  async reconnect(subscriberId: string, input: ReconnectInput) {
    const { userId } = currentContext();
    const settings = await this.settings();
    const result = await this.prisma.tenantTransaction(async (tx) => {
      await lockMoney(tx, this.orgId());
      const s = await tx.subscriber.findUnique({ where: { id: subscriberId } });
      if (!s) throw new NotFoundException('Suscriptor no encontrado');
      if (s.serviceStatus !== 'suspended') throw new BadRequestException('El servicio no está suspendido');
      const balance = await this.balance(tx, s.id);
      if (balance > 0 && !input.allowWithDebt) {
        throw new BadRequestException({ code: 'DEBT_PENDING', balance, message: `El suscriptor debe ${balance.toLocaleString('es-CO')}. Registra el pago o indica el acuerdo de pago` });
      }
      const fee = input.reconnectionFee ?? settings.reconnectionFee;
      const charge = fee > 0
        ? await tx.subscriberCharge.create({ data: { organizationId: this.orgId(), subscriberId: s.id, concept: 'reconexion', description: 'Cargo por reconexión del servicio', amount: fee, createdById: userId } })
        : null;
      const ev = await tx.serviceEvent.create({
        data: {
          organizationId: this.orgId(), subscriberId: s.id, type: 'reconnection', date: new Date(input.date),
          reason: balance > 0 ? 'Reconexión con deuda (acuerdo)' : 'Reconexión', notes: input.notes, balanceAtEvent: balance, chargeId: charge?.id, userId,
        },
      });
      await tx.subscriber.update({ where: { id: s.id }, data: { serviceStatus: 'connected' } });
      return { ev, s, balance, fee };
    });
    await this.audit.log({ action: 'service.reconnected', entity: 'subscriber', entityId: subscriberId, data: { code: result.s.code, balance: result.balance, fee: result.fee, withDebt: result.balance > 0 } });
    return { id: result.ev.id, serviceStatus: 'connected', reconnectionFee: result.fee };
  }
}

@Controller('collections')
@TenantScoped()
class CollectionsController {
  constructor(private readonly c: CollectionsService) {}

  @Get('settings')
  settings() {
    return this.c.settings();
  }

  @Put('settings')
  @TenantScoped('owner', 'admin')
  saveSettings(@Body(new ZodPipe(collectionSettingsSchema)) body: CollectionSettings) {
    return this.c.saveSettings(body);
  }

  @Get('charges')
  charges(@Query('subscriberId') subscriberId?: string) {
    return this.c.charges(subscriberId && /^[0-9a-f-]{36}$/.test(subscriberId) ? subscriberId : undefined);
  }

  @Post('charges')
  @TenantScoped('owner', 'admin')
  addCharge(@Body(new ZodPipe(createChargeSchema)) body: z.infer<typeof createChargeSchema>) {
    return this.c.addCharge(body);
  }

  @Delete('charges/:id')
  @TenantScoped('owner', 'admin')
  @HttpCode(204)
  voidCharge(@Param('id', ParseUUIDPipe) id: string) {
    return this.c.voidCharge(id);
  }

  @Get('subscribers/:id/events')
  events(@Param('id', ParseUUIDPipe) id: string) {
    return this.c.events(id);
  }

  @Post('subscribers/:id/suspend')
  @TenantScoped('owner', 'admin')
  suspend(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(suspendSchema)) body: z.infer<typeof suspendSchema>) {
    return this.c.suspend(id, body);
  }

  @Post('subscribers/:id/reconnect')
  @TenantScoped('owner', 'admin')
  reconnect(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reconnectSchema)) body: ReconnectInput) {
    return this.c.reconnect(id, body);
  }
}

@Module({ controllers: [CollectionsController], providers: [CollectionsService], exports: [CollectionsService] })
export class CollectionsModule {}
