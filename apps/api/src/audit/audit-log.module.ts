import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AUDIT_CATEGORIES } from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformAdmin, TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';

const querySchema = z.object({
  category: z.string().max(40).optional(),
  /** Paginación por cursor: id de la última fila recibida. */
  before: z.string().regex(/^\d{1,20}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  organizationId: z.string().uuid().optional(),
});
type AuditQuery = z.infer<typeof querySchema>;

/** Acciones que el superadmin ve de cualquier acueducto: las de la relación comercial y de soporte, no la operación. */
const PLATFORM_VISIBLE_PREFIXES = ['saas.', 'organization.', 'support.'];

function categoryFilter(category?: string): Prisma.AuditLogWhereInput {
  const cat = AUDIT_CATEGORIES.find((c) => c.key === category);
  return cat ? { OR: cat.prefixes.map((p) => ({ action: { startsWith: p } })) } : {};
}

/**
 * Bitácora (platform.audit_logs, solo inserción). El acueducto ve la suya completa, incluido cada paso del
 * soporte de AguaMata. El superadmin ve lo de la plataforma y, de los acueductos, solo cobro, estado y soporte.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  private async page(where: Prisma.AuditLogWhereInput, q: AuditQuery) {
    const rows = await this.prisma.platform.auditLog.findMany({
      where: { ...where, ...(q.before ? { id: { lt: BigInt(q.before) } } : {}) },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
    const items = rows.slice(0, q.limit);
    const actorIds = [...new Set(items.map((r) => r.actorUserId).filter(Boolean) as string[])];
    const orgIds = [...new Set(items.map((r) => r.organizationId).filter(Boolean) as string[])];
    const [actors, orgs] = await Promise.all([
      this.prisma.platform.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true, email: true, isPlatformAdmin: true } }),
      this.prisma.platform.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }),
    ]);
    const actor = new Map(actors.map((a) => [a.id, a]));
    const org = new Map(orgs.map((o) => [o.id, o.name]));
    return {
      items: items.map((r) => {
        const a = r.actorUserId ? actor.get(r.actorUserId) : undefined;
        return {
          id: r.id.toString(), occurredAt: r.occurredAt, action: r.action, entity: r.entity, entityId: r.entityId, data: r.data, ip: r.ip,
          organization: r.organizationId ? { id: r.organizationId, name: org.get(r.organizationId) ?? null } : null,
          actor: a ? { name: a.fullName, email: a.email, isSupport: a.isPlatformAdmin } : null,
        };
      }),
      nextBefore: rows.length > q.limit ? items[items.length - 1].id.toString() : null,
    };
  }

  forTenant(q: AuditQuery) {
    return this.page({ organizationId: currentContext().organizationId, ...categoryFilter(q.category) }, q);
  }

  forPlatform(q: AuditQuery) {
    const scope: Prisma.AuditLogWhereInput = q.organizationId
      ? { organizationId: q.organizationId, OR: PLATFORM_VISIBLE_PREFIXES.map((p) => ({ action: { startsWith: p } })) }
      : { OR: [{ organizationId: null }, ...PLATFORM_VISIBLE_PREFIXES.map((p) => ({ action: { startsWith: p } }))] };
    return this.page({ AND: [scope, categoryFilter(q.category)] }, q);
  }
}

@Controller('audit')
@TenantScoped('owner', 'admin')
class TenantAuditController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  list(@Query(new ZodPipe(querySchema)) q: AuditQuery) {
    return this.audit.forTenant({ ...q, organizationId: undefined });
  }
}

@Controller('platform/audit')
@PlatformAdmin()
class PlatformAuditController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  list(@Query(new ZodPipe(querySchema)) q: AuditQuery) {
    return this.audit.forPlatform(q);
  }
}

@Module({ controllers: [TenantAuditController, PlatformAuditController], providers: [AuditLogService] })
export class AuditLogModule {}
