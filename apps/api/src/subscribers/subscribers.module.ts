import { Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createSubscriberSchema, CreateSubscriberInput, updateSubscriberSchema, UpdateSubscriberInput } from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';

/**
 * Ejemplo de módulo de tenant. Fíjate en que NINGUNA consulta filtra por organization_id a mano para leer:
 * RLS lo hace en la base de datos. Al crear, organization_id sale del contexto, nunca del cuerpo de la petición.
 */
@Injectable()
export class SubscribersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.tenant.subscriber.findMany({ orderBy: { code: 'asc' }, take: 500 });
  }

  async get(id: string) {
    const s = await this.prisma.tenant.subscriber.findUnique({ where: { id } });
    if (!s) throw new NotFoundException();
    return s;
  }

  /** Edición. El código no cambia (es la referencia en lecturas y facturas); las facturas ya emitidas guardan su copia. */
  async update(id: string, input: UpdateSubscriberInput) {
    const s = await this.prisma.tenant.subscriber.findUnique({ where: { id } });
    if (!s) throw new NotFoundException();
    const updated = await this.prisma.tenant.subscriber.update({ where: { id }, data: input });
    await this.audit.log({ action: 'subscriber.updated', entity: 'subscriber', entityId: id, data: { changes: input as Prisma.InputJsonValue } });
    return updated;
  }

  async create(input: CreateSubscriberInput) {
    const organizationId = currentContext().organizationId!;
    await this.entitlements.assertFeature(organizationId, 'subscribers');
    const count = await this.prisma.tenant.subscriber.count();
    await this.entitlements.assertWithinLimit(organizationId, 'max_subscribers', count);

    try {
      const s = await this.prisma.tenant.subscriber.create({ data: { ...input, organizationId } });
      await this.audit.log({ action: 'subscriber.created', entity: 'subscriber', entityId: s.id });
      return s;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ya existe un suscriptor con ese código');
      }
      throw e;
    }
  }
}

@Controller('subscribers')
@TenantScoped()
class SubscribersController {
  constructor(private readonly subscribers: SubscribersService) {}

  @Get()
  list() {
    return this.subscribers.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.subscribers.get(id);
  }

  @Patch(':id')
  @TenantScoped('owner', 'admin', 'operator')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateSubscriberSchema)) body: UpdateSubscriberInput) {
    return this.subscribers.update(id, body);
  }

  @Post()
  @TenantScoped('owner', 'admin', 'operator')
  create(@Body(new ZodPipe(createSubscriberSchema)) body: CreateSubscriberInput) {
    return this.subscribers.create(body);
  }
}

@Module({ controllers: [SubscribersController], providers: [SubscribersService] })
export class SubscribersModule {}
