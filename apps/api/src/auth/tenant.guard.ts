import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { currentContext } from '../common/request-context';
import type { Principal } from './session.service';

const ROLES_KEY = 'roles';
const ALLOW_READ_ONLY = 'allowWhenReadOnly';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Sin suscripción vigente la cuenta queda en solo lectura: se consulta y exporta, pero no se modifica. */
const READ_ONLY_SUBSCRIPTION = new Set(['suspended', 'cancelled']);
const BLOCKED_STATUSES = new Set(['suspended', 'deactivated']);

/**
 * Única puerta de entrada al plano de datos. Revalida la membresía contra la BD en cada petición
 * (un token viejo no sirve si quitaron al usuario) y solo entonces fija organizationId en el contexto.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user: Principal | undefined = req.user;
    if (!user?.orgId) throw new ForbiddenException('Se requiere una organización activa');

    const membership = await this.prisma.platform.membership.findUnique({
      where: { userId_organizationId: { userId: user.sub, organizationId: user.orgId } },
      include: { organization: { select: { status: true } } },
    });
    if (!membership) throw new ForbiddenException('Sin acceso a esta organización');
    if (membership.status !== 'active') throw new ForbiddenException('Tu acceso a esta organización fue desactivado');
    if (BLOCKED_STATUSES.has(membership.organization.status)) {
      throw new ForbiddenException('La organización está suspendida o desactivada');
    }

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (roles?.length && !roles.includes(membership.role)) {
      throw new ForbiddenException('Rol insuficiente');
    }

    if (!SAFE_METHODS.has(req.method) && !this.reflector.getAllAndOverride<boolean>(ALLOW_READ_ONLY, [context.getHandler(), context.getClass()])) {
      const sub = await this.prisma.platform.subscription.findFirst({
        where: { organizationId: membership.organizationId }, orderBy: { createdAt: 'desc' }, select: { status: true },
      });
      if (!sub || READ_ONLY_SUBSCRIPTION.has(sub.status)) {
        throw new ForbiddenException({
          code: 'SUBSCRIPTION_READ_ONLY',
          message: 'La cuenta está en modo de solo lectura por falta de pago. Puedes consultar tu información; para registrar cambios, paga la suscripción',
        });
      }
    }

    const ctx = currentContext();
    ctx.organizationId = membership.organizationId;
    ctx.role = membership.role;
    return true;
  }
}
