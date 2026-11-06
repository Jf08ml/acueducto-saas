import { BadRequestException, Body, Controller, ForbiddenException, Get, Global, Injectable, Module, Patch, Post, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { changePasswordSchema, loginSchema } from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../common/request-context';
import { JwtAuthGuard, JwtPayload } from './jwt-auth.guard';
import { TenantGuard } from './tenant.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { Public } from './decorators';

const loginWithOrgSchema = loginSchema.extend({ organizationId: z.string().uuid().optional() });
const switchSchema = z.object({ organizationId: z.string().uuid() });
const USABLE_ORG = new Set(['onboarding', 'active']);

type MembershipWithOrg = { organizationId: string; role: string; status: string; organization: { id: string; name: string; slug: string; status: string } };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  private usable(m: MembershipWithOrg) {
    return m.status === 'active' && USABLE_ORG.has(m.organization.status);
  }

  private async session(user: { id: string; email: string; fullName: string; isPlatformAdmin: boolean }, memberships: MembershipWithOrg[], active?: MembershipWithOrg) {
    const payload: JwtPayload = { sub: user.id, orgId: active?.organizationId, pa: user.isPlatformAdmin || undefined };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, fullName: user.fullName, isPlatformAdmin: user.isPlatformAdmin },
      activeOrganizationId: active?.organizationId ?? null,
      organizations: memberships.filter((m) => m.status === 'active').map((m) => ({ ...m.organization, role: m.role })),
    };
  }

  async login(input: z.infer<typeof loginWithOrgSchema>) {
    const user = await this.prisma.platform.user.findUnique({
      where: { email: input.email.toLowerCase() },
      include: { memberships: { include: { organization: { select: { id: true, name: true, slug: true, status: true } } }, orderBy: { createdAt: 'asc' } } },
    });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    let membership: MembershipWithOrg | undefined;
    if (input.organizationId) {
      membership = user.memberships.find((m) => m.organizationId === input.organizationId);
      if (!membership) throw new UnauthorizedException('Sin acceso a esa organización');
      if (membership.status !== 'active') throw new UnauthorizedException('Tu acceso a esta organización fue desactivado');
    } else {
      membership = user.memberships.find((m) => this.usable(m)) ?? user.memberships.find((m) => m.status === 'active');
    }

    await this.prisma.platform.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ action: 'auth.login', actorUserId: user.id, organizationId: membership?.organizationId });
    return this.session(user, user.memberships, membership);
  }

  async organizations() {
    const memberships = await this.prisma.platform.membership.findMany({
      where: { userId: currentContext().userId!, status: 'active' },
      include: { organization: { select: { id: true, name: true, slug: true, status: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({ ...m.organization, role: m.role }));
  }

  /** Cambia el acueducto activo y emite un token nuevo. */
  async switch(organizationId: string) {
    const userId = currentContext().userId!;
    const user = await this.prisma.platform.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { organization: { select: { id: true, name: true, slug: true, status: true } } } } },
    });
    const m = user.memberships.find((x) => x.organizationId === organizationId);
    if (!m || m.status !== 'active') throw new ForbiddenException('Sin acceso a esa organización');
    await this.audit.log({ action: 'auth.switch_org', actorUserId: userId, organizationId });
    return this.session(user, user.memberships, m);
  }

  async changePassword(input: z.infer<typeof changePasswordSchema>) {
    const userId = currentContext().userId!;
    const user = await this.prisma.platform.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) throw new BadRequestException('La contraseña actual no es correcta');
    await this.prisma.platform.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(input.newPassword, 10) } });
    await this.audit.log({ action: 'auth.password_changed', actorUserId: userId });
    return { ok: true };
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

  @Get('organizations')
  organizations() {
    return this.auth.organizations();
  }

  @Post('switch')
  switch(@Body(new ZodPipe(switchSchema)) body: z.infer<typeof switchSchema>) {
    return this.auth.switch(body.organizationId);
  }

  @Patch('password')
  password(@Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>) {
    return this.auth.changePassword(body);
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
