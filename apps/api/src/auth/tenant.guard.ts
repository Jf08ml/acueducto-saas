import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../common/request-context';
import type { Principal } from './session.service';

const ROLES_KEY = 'roles';
const ALLOW_READ_ONLY = 'allowWhenReadOnly';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Sin suscripción vigente la cuenta queda en solo lectura: se consulta y exporta, pero no se modifica. */
const READ_ONLY_SUBSCRIPTION = new Set(['suspended', 'cancelled']);
const BLOCKED_STATUSES = new Set(['suspended', 'deactivated']);
/** Rol con el que actúa una sesión de soporte aprobada (nunca el de dueño). */
const SUPPORT_ROLE = 'admin';

/**
 * Única puerta de entrada al plano de datos. Revalida en cada petición, contra la BD:
 *  - la membresía (un token viejo no sirve si quitaron al usuario), o
 *  - el permiso de soporte aprobado por el acueducto (vigente, no revocado y del mismo acueducto),
 * y solo entonces fija organizationId en el contexto. Cada petición de soporte queda en la auditoría.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user: Principal | undefined = req.user;
    if (!user?.orgId) throw new ForbiddenException('Se requiere una organización activa');

    let organizationId: string;
    let role: string;
    let orgStatus: string;
    if (user.supportGrantId) {
      const grant = await this.prisma.platform.supportAccessGrant.findUnique({
        where: { id: user.supportGrantId }, include: { organization: { select: { status: true } } },
      });
      const valid = grant && grant.status === 'approved' && grant.organizationId === user.orgId && grant.requestedById === user.sub
        && grant.expiresAt && grant.expiresAt.getTime() > Date.now();
      if (!valid) throw new ForbiddenException({ code: 'SUPPORT_ACCESS_ENDED', message: 'El acceso de soporte terminó o fue revocado por el acueducto' });
      if (grant.scope === 'read' && !SAFE_METHODS.has(req.method)) {
        throw new ForbiddenException('El acceso de soporte aprobado es solo de consulta');
      }
      organizationId = grant.organizationId;
      role = SUPPORT_ROLE;
      orgStatus = grant.organization.status;
    } else {
      const membership = await this.prisma.platform.membership.findUnique({
        where: { userId_organizationId: { userId: user.sub, organizationId: user.orgId } },
        include: { organization: { select: { status: true } } },
      });
      if (!membership) throw new ForbiddenException('Sin acceso a esta organización');
      if (membership.status !== 'active') throw new ForbiddenException('Tu acceso a esta organización fue desactivado');
      organizationId = membership.organizationId;
      role = membership.role;
      orgStatus = membership.organization.status;
    }

    if (BLOCKED_STATUSES.has(orgStatus)) throw new ForbiddenException('La organización está suspendida o desactivada');

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (roles?.length && !roles.includes(role)) throw new ForbiddenException('Rol insuficiente');

    if (!SAFE_METHODS.has(req.method) && !this.reflector.getAllAndOverride<boolean>(ALLOW_READ_ONLY, [context.getHandler(), context.getClass()])) {
      const sub = await this.prisma.platform.subscription.findFirst({
        where: { organizationId }, orderBy: { createdAt: 'desc' }, select: { status: true },
      });
      if (!sub || READ_ONLY_SUBSCRIPTION.has(sub.status)) {
        throw new ForbiddenException({
          code: 'SUBSCRIPTION_READ_ONLY',
          message: 'La cuenta está en modo de solo lectura por falta de pago. Puedes consultar tu información; para registrar cambios, paga la suscripción',
        });
      }
    }

    const ctx = currentContext();
    ctx.organizationId = organizationId;
    ctx.role = role;
    if (user.supportGrantId) {
      ctx.supportGrantId = user.supportGrantId;
      // Sin parámetros de búsqueda: pueden traer datos personales y la ruta basta para saber qué se consultó.
      const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
      await this.audit.log({ action: 'support.request', entity: 'support_grant', entityId: user.supportGrantId, organizationId, data: { method: req.method, path } });
    }
    return true;
  }
}
