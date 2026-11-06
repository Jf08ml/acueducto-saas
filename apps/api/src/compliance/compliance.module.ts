import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch } from '@nestjs/common';
import { z } from 'zod';
import { complianceUpdateSchema } from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';

interface AppliesTo {
  organizationTypes?: string[];
  legalNatures?: string[];
  providerTypes?: string[];
  areaTypes?: string[];
  minSubscribers?: number;
  maxSubscribers?: number;
}

interface OrgProfile {
  organizationType: string;
  legalNature: string | null;
  providerType: string | null;
  areaType: string | null;
  estimatedSubscribers: number;
}

export function obligationApplies(rule: AppliesTo, org: OrgProfile): boolean {
  const inList = (list: string[] | undefined, v: string | null) => !list || (v !== null && list.includes(v));
  return (
    inList(rule.organizationTypes, org.organizationType) &&
    inList(rule.legalNatures, org.legalNature) &&
    inList(rule.providerTypes, org.providerType) &&
    inList(rule.areaTypes, org.areaType) &&
    (rule.minSubscribers === undefined || org.estimatedSubscribers >= rule.minSubscribers) &&
    (rule.maxSubscribers === undefined || org.estimatedSubscribers <= rule.maxSubscribers)
  );
}

@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Genera o actualiza la lista de obligaciones según el perfil. Agrega las que ahora aplican;
   * elimina solo las que dejaron de aplicar y que seguían pendientes (no borra trabajo ya registrado).
   */
  async syncForCurrentOrg() {
    const organizationId = currentContext().organizationId!;
    const [org, catalog, existing] = await Promise.all([
      this.prisma.platform.organization.findUniqueOrThrow({ where: { id: organizationId } }),
      this.prisma.platform.regulatoryObligation.findMany({ where: { isActive: true } }),
      this.prisma.tenant.complianceItem.findMany(),
    ]);
    const applicable = new Set(catalog.filter((o) => obligationApplies(o.appliesTo as AppliesTo, org)).map((o) => o.code));
    const have = new Set(existing.map((i) => i.obligationCode));

    const toAdd = [...applicable].filter((c) => !have.has(c));
    const toRemove = existing.filter((i) => !applicable.has(i.obligationCode) && i.status === 'pending').map((i) => i.id);

    if (toAdd.length) {
      await this.prisma.tenant.complianceItem.createMany({ data: toAdd.map((obligationCode) => ({ organizationId, obligationCode })) });
    }
    if (toRemove.length) {
      await this.prisma.tenant.complianceItem.deleteMany({ where: { id: { in: toRemove } } });
    }
    return { added: toAdd.length, removed: toRemove.length, total: applicable.size };
  }

  async list() {
    const [items, catalog] = await Promise.all([
      this.prisma.tenant.complianceItem.findMany(),
      this.prisma.platform.regulatoryObligation.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);
    const byCode = new Map(catalog.map((c) => [c.code, c]));
    return items
      .map((i) => ({ ...i, obligation: byCode.get(i.obligationCode) ?? null }))
      .sort((a, b) => (a.obligation?.sortOrder ?? 0) - (b.obligation?.sortOrder ?? 0));
  }

  async update(code: string, input: z.infer<typeof complianceUpdateSchema>) {
    const item = await this.prisma.tenant.complianceItem.findFirst({ where: { obligationCode: code } });
    if (!item) throw new NotFoundException();
    const updated = await this.prisma.tenant.complianceItem.update({
      where: { id: item.id },
      data: {
        status: input.status,
        dueDate: input.dueDate === undefined ? undefined : input.dueDate ? new Date(input.dueDate) : null,
        notes: input.notes === undefined ? undefined : input.notes,
      },
    });
    await this.audit.log({ action: 'compliance.updated', entity: 'compliance_item', entityId: item.id, data: { code, status: input.status } });
    return updated;
  }
}

@Controller('compliance')
@TenantScoped()
class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get()
  list() {
    return this.compliance.list();
  }

  @Patch(':code')
  @TenantScoped('owner', 'admin')
  update(@Param('code') code: string, @Body(new ZodPipe(complianceUpdateSchema)) body: z.infer<typeof complianceUpdateSchema>) {
    return this.compliance.update(code, body);
  }
}

@Module({ controllers: [ComplianceController], providers: [ComplianceService], exports: [ComplianceService] })
export class ComplianceModule {}
