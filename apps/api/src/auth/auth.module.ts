import { Body, Controller, Global, Injectable, Module, Post, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { loginSchema } from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard, JwtPayload } from './jwt-auth.guard';
import { TenantGuard } from './tenant.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { Public } from './decorators';

const loginWithOrgSchema = loginSchema.extend({ organizationId: z.string().uuid().optional() });

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(input: z.infer<typeof loginWithOrgSchema>) {
    const user = await this.prisma.platform.user.findUnique({
      where: { email: input.email.toLowerCase() },
      include: { memberships: { include: { organization: { select: { id: true, name: true, slug: true, status: true } } } } },
    });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const membership = input.organizationId
      ? user.memberships.find((m) => m.organizationId === input.organizationId)
      : user.memberships[0];
    if (input.organizationId && !membership) throw new UnauthorizedException('Sin acceso a esa organización');

    const payload: JwtPayload = { sub: user.id, orgId: membership?.organizationId, pa: user.isPlatformAdmin || undefined };
    await this.audit.log({ action: 'auth.login', actorUserId: user.id, organizationId: membership?.organizationId });

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, fullName: user.fullName, isPlatformAdmin: user.isPlatformAdmin },
      activeOrganizationId: membership?.organizationId ?? null,
      organizations: user.memberships.map((m) => ({ ...m.organization, role: m.role })),
    };
  }
}

@Controller('auth')
class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body(new ZodPipe(loginWithOrgSchema)) body: z.infer<typeof loginWithOrgSchema>) {
    return this.auth.login(body);
  }
}

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => {
        if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET no está configurado');
        return { secret: process.env.JWT_SECRET, signOptions: { expiresIn: '8h' } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TenantGuard, PlatformAdminGuard, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [AuthService, TenantGuard, PlatformAdminGuard],
})
export class AuthModule {}
