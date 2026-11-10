import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { currentContext } from '../common/request-context';
import { IS_PUBLIC } from './decorators';
import { CSRF_HEADER, CSRF_VALUE, Principal, readCookie, SESSION_COOKIE, SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Autenticación global. La sesión llega en la cookie httpOnly (navegador) o como `Authorization: Bearer`
 * (pruebas e integraciones). Con cookie, toda petición que modifica datos debe traer el encabezado
 * X-Requested-With: un sitio ajeno no puede ponerlo sin pasar por CORS, así que no puede falsificar peticiones.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: Principal }>();
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookie = bearer ? undefined : readCookie(req, SESSION_COOKIE);
    const token = bearer ?? cookie;
    if (!token) throw new UnauthorizedException();

    if (cookie && !SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      throw new ForbiddenException('Petición rechazada (CSRF)');
    }

    const s = await this.sessions.resolve(token);
    if (!s) throw new UnauthorizedException();

    req.user = {
      sub: s.userId,
      sid: s.id,
      orgId: s.organizationId ?? undefined,
      pa: s.user.isPlatformAdmin || undefined,
      supportGrantId: s.supportGrantId ?? undefined,
    };
    const ctx = currentContext();
    ctx.userId = s.userId;
    ctx.sessionId = s.id;
    ctx.isPlatformAdmin = s.user.isPlatformAdmin;
    return true;
  }
}
