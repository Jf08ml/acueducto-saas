import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformAdmin } from '../auth/decorators';

const statusSchema = z.object({ status: z.enum(['active', 'suspended', 'deactivated']), reason: z.string().min(3) });

/**
 * Panel Superadmin. Solo usa el cliente `platform`: aunque intentara leer tenant.*, RLS no le devolvería filas.
 * El conteo de suscriptores sale de una función SECURITY DEFINER que solo expone números agregados.
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listOrganizations() {
    const [orgs, counts] = await Promise.all([
      this.prisma.platform.organization.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          subscriptions: { orderBy: { createdAt: 'desc' }, take: 1, include: { plan: { select: { code: true, name: true } } } },
        },
      }),
      this.prisma.platform.$queryRaw<{ organization_id: string; total: bigint }[]>`SELECT * FROM platform.subscriber_counts()`,
    ]);
    const byOrg = new Map(counts.map((c) => [c.organization_id, Number(c.total)]));

    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      nit: `${o.nit}-${o.nitDv}`,
      municipality: o.municipality,
      department: o.department,
      status: o.status,
      plan: o.subscriptions[0]?.plan ?? null,
      subscriptionStatus: o.subscriptions[0]?.status ?? null,
      currentPeriodEnd: o.subscriptions[0]?.currentPeriodEnd ?? null,
      billingCycle: o.subscriptions[0]?.billingCycle ?? null,
      subscriberCount: byOrg.get(o.id) ?? 0,
      createdAt: o.createdAt,
    }));
  }

  async setStatus(id: string, input: z.infer<typeof statusSchema>) {
    const org = await this.prisma.platform.organization.update({ where: { id }, data: { status: input.status } });
    await this.audit.log({ action: `organization.${input.status}`, entity: 'organization', entityId: id, organizationId: id, data: { reason: input.reason } });
    return { id: org.id, status: org.status };
  }

  listPlans() {
    return this.prisma.platform.plan.findMany({ orderBy: { priceMonthlyCop: 'asc' }, include: { features: true, limits: true } });
  }
}

@Controller('platform')
@PlatformAdmin()
class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('organizations')
  organizations() {
    return this.platform.listOrganizations();
  }

  @Patch('organizations/:id/status')
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(statusSchema)) body: z.infer<typeof statusSchema>) {
    return this.platform.setStatus(id, body);
  }

  @Get('plans')
  plans() {
    return this.platform.listPlans();
  }
}

@Module({ controllers: [PlatformController], providers: [PlatformService] })
export class PlatformModule {}
