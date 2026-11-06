import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (!req.user?.pa) throw new ForbiddenException();
    const user = await this.prisma.platform.user.findUnique({ where: { id: req.user.sub }, select: { isPlatformAdmin: true } });
    if (!user?.isPlatformAdmin) throw new ForbiddenException();
    return true;
  }
}
