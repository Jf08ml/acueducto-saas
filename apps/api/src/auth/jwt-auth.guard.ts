import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { currentContext } from '../common/request-context';
import { IS_PUBLIC } from './decorators';

export interface JwtPayload {
  sub: string;
  orgId?: string;
  pa?: boolean;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
      req.user = payload;
      const ctx = currentContext();
      ctx.userId = payload.sub;
      ctx.isPlatformAdmin = payload.pa === true;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
