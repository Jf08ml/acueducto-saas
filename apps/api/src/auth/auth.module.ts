import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Global, HttpCode, Injectable, Logger, Module, NotFoundException, Param, Patch,
  Post, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  changePasswordSchema, loginSchema, PASSWORD_RESET_TTL_MINUTES, requestPasswordResetSchema, RequestPasswordResetInput, resetPasswordSchema,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import { emailLayout, MailService } from '../mail/mail.service';
import { currentContext } from '../common/request-context';
import { orgPublicUrl, platformOrigin } from '../domains/domains.module';
import { SessionAuthGuard } from './session-auth.guard';
import { hashToken, Principal, SessionService } from './session.service';
import { TenantGuard } from './tenant.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { Public } from './decorators';

const loginWithOrgSchema = loginSchema.extend({ organizationId: z.string().uuid().optional() });
const switchSchema = z.object({ organizationId: z.string().uuid() });
const USABLE_ORG = new Set(['onboarding', 'active']);
/** Máximo de enlaces de recuperación por usuario y hora (evita usar la función para inundar un buzón). */
const MAX_RESETS_PER_HOUR = 3;

type MembershipWithOrg = { organizationId: string; role: string; status: string; organization: { id: string; name: string; slug: string; status: string } };
type AuthUser = { id: string; email: string; fullName: string; isPlatformAdmin: boolean };

const ORG_SELECT = { select: { id: true, name: true, slug: true, status: true } } as const;

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private usable(m: MembershipWithOrg) {
    return m.status === 'active' && USABLE_ORG.has(m.organization.status);
  }

  private view(user: AuthUser, memberships: MembershipWithOrg[], activeOrganizationId: string | null) {
    return {
      user: { id: user.id, email: user.email, fullName: user.fullName, isPlatformAdmin: user.isPlatformAdmin },
      activeOrganizationId,
      organizations: memberships.filter((m) => m.status === 'active').map((m) => ({ ...m.organization, role: m.role })),
    };
  }

  /** Verifica credenciales y abre una sesión. Devuelve el token (para la cookie) y lo que ve la web. */
  async login(req: Request, input: z.infer<typeof loginWithOrgSchema>) {
    const user = await this.prisma.platform.user.findUnique({
      where: { email: input.email.toLowerCase() },
      include: { memberships: { include: { organization: ORG_SELECT }, orderBy: { createdAt: 'asc' } } },
    });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      await this.audit.log({ action: 'auth.login_failed', organizationId: input.organizationId, data: { email: input.email.toLowerCase() } });
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

    const { token, session } = await this.sessions.create(req, user.id, membership?.organizationId);
    await this.prisma.platform.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ action: 'auth.login', actorUserId: user.id, organizationId: membership?.organizationId, entity: 'session', entityId: session.id });
    return { token, body: this.view(user, user.memberships, membership?.organizationId ?? null) };
  }

  async logout(principal: Principal) {
    await this.sessions.revoke(principal.sid);
    await this.audit.log({ action: 'auth.logout', entity: 'session', entityId: principal.sid, organizationId: principal.orgId });
  }

  /** Datos de la sesión actual (la web los usa al cargar, ya que no puede leer la cookie). */
  async session(principal: Principal) {
    const user = await this.prisma.platform.user.findUniqueOrThrow({
      where: { id: principal.sub },
      include: { memberships: { include: { organization: ORG_SELECT }, orderBy: { createdAt: 'asc' } } },
    });
    return { ...this.view(user, user.memberships, principal.orgId ?? null), support: principal.supportGrantId ? { grantId: principal.supportGrantId } : null };
  }

  async organizations() {
    const memberships = await this.prisma.platform.membership.findMany({
      where: { userId: currentContext().userId!, status: 'active' },
      include: { organization: ORG_SELECT },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({ ...m.organization, role: m.role }));
  }

  /** Cambia el acueducto activo de la sesión actual. */
  async switch(principal: Principal, organizationId: string) {
    if (principal.supportGrantId) throw new ForbiddenException('Una sesión de soporte no puede cambiar de acueducto');
    const user = await this.prisma.platform.user.findUniqueOrThrow({
      where: { id: principal.sub },
      include: { memberships: { include: { organization: ORG_SELECT } } },
    });
    const m = user.memberships.find((x) => x.organizationId === organizationId);
    if (!m || m.status !== 'active') throw new ForbiddenException('Sin acceso a esa organización');
    await this.sessions.setOrganization(principal.sid, organizationId);
    await this.audit.log({ action: 'auth.switch_org', actorUserId: user.id, organizationId });
    return this.view(user, user.memberships, organizationId);
  }

  /** Cambia la contraseña y cierra las demás sesiones del usuario. */
  async changePassword(principal: Principal, input: z.infer<typeof changePasswordSchema>) {
    const user = await this.prisma.platform.user.findUniqueOrThrow({ where: { id: principal.sub } });
    if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) throw new BadRequestException('La contraseña actual no es correcta');
    await this.prisma.platform.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(input.newPassword, 10) } });
    const closed = await this.sessions.revokeAllForUser(user.id, principal.sid);
    await this.audit.log({ action: 'auth.password_changed', actorUserId: user.id, data: { otherSessionsClosed: closed.count } });
    return { ok: true, otherSessionsClosed: closed.count };
  }

  // ───── Recuperación de contraseña (pública) ─────

  /**
   * Siempre responde lo mismo, exista o no el correo: así no se puede averiguar quién tiene cuenta.
   * Si se pide desde la dirección de un acueducto, el enlace apunta a esa dirección (y usa su marca).
   */
  async requestReset(req: Request, input: RequestPasswordResetInput) {
    const user = await this.prisma.platform.user.findUnique({ where: { email: input.email } });
    if (!user) return { ok: true };

    const recent = await this.prisma.platform.passwordReset.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
    if (recent >= MAX_RESETS_PER_HOUR) {
      this.log.warn(`Recuperación de contraseña: límite por hora alcanzado para ${user.id}`);
      return { ok: true };
    }

    let base = platformOrigin();
    let orgName = 'AguaMata';
    let color: string | undefined;
    let replyTo: string | undefined;
    if (input.organizationId) {
      const member = await this.prisma.platform.membership.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: input.organizationId } } });
      if (member) {
        const { org, url } = await orgPublicUrl(this.prisma, input.organizationId);
        base = url;
        orgName = org.name;
        color = (org.branding as { primaryColor?: string }).primaryColor;
        replyTo = org.contactEmail;
      }
    }

    const token = randomBytes(32).toString('base64url');
    await this.prisma.platform.passwordReset.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000), ip: req.ip },
    });
    const link = `${base}/recuperar?token=${token}`;
    const lines = [
      `Hola, ${user.fullName}. Recibimos una solicitud para cambiar la contraseña de tu cuenta ${user.email}.`,
      `El enlace sirve una sola vez y vence en ${PASSWORD_RESET_TTL_MINUTES} minutos. Si no fuiste tú, ignora este mensaje: tu contraseña no cambia.`,
    ];
    const sent = await this.mail.send(
      {
        to: user.email,
        replyTo,
        subject: 'Cambia tu contraseña',
        text: `${lines[0]}\n\nCámbiala aquí: ${link}\n\n${lines[1]}`,
        html: emailLayout({ orgName, color, title: 'Cambia tu contraseña', paragraphs: lines, cta: { label: 'Crear contraseña nueva', url: link } }),
      },
      orgName === 'AguaMata' ? undefined : orgName,
    );
    await this.audit.log({ action: 'auth.password_reset_requested', actorUserId: user.id, organizationId: input.organizationId, data: { emailDelivered: sent.delivered, provider: sent.provider } });
    return { ok: true };
  }

  private async findReset(token: string) {
    const r = await this.prisma.platform.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { select: { email: true } } } });
    if (!r) throw new NotFoundException('El enlace no es válido');
    if (r.usedAt) throw new BadRequestException('Este enlace ya se usó. Pide uno nuevo');
    if (r.expiresAt.getTime() < Date.now()) throw new BadRequestException('El enlace venció. Pide uno nuevo');
    return r;
  }

  async describeReset(token: string) {
    const r = await this.findReset(token);
    return { email: r.user.email, expiresAt: r.expiresAt };
  }

  /** Fija la contraseña nueva, invalida el enlace y cierra TODAS las sesiones del usuario. */
  async resetPassword(token: string, password: string) {
    const r = await this.findReset(token);
    const claimed = await this.prisma.platform.passwordReset.updateMany({ where: { id: r.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new BadRequestException('Este enlace ya se usó. Pide uno nuevo');
    await this.prisma.platform.user.update({ where: { id: r.userId }, data: { passwordHash: await bcrypt.hash(password, 10) } });
    // Los demás enlaces pendientes del usuario dejan de servir.
    await this.prisma.platform.passwordReset.updateMany({ where: { userId: r.userId, usedAt: null }, data: { usedAt: new Date() } });
    const closed = await this.sessions.revokeAllForUser(r.userId);
    await this.audit.log({ action: 'auth.password_reset', actorUserId: r.userId, data: { sessionsClosed: closed.count } });
    return { ok: true, email: r.user.email };
  }
}

type AuthedRequest = Request & { user: Principal };

@Controller('auth')
class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('login')
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body(new ZodPipe(loginWithOrgSchema)) body: z.infer<typeof loginWithOrgSchema>) {
    const { token, body: view } = await this.auth.login(req, body);
    this.sessions.setCookie(req, res, token);
    return view;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.user);
    this.sessions.clearCookie(req, res);
  }

  @Get('session')
  session(@Req() req: AuthedRequest) {
    return this.auth.session(req.user);
  }

  @Get('organizations')
  organizations() {
    return this.auth.organizations();
  }

  @Post('switch')
  switch(@Req() req: AuthedRequest, @Body(new ZodPipe(switchSchema)) body: z.infer<typeof switchSchema>) {
    return this.auth.switch(req.user, body.organizationId);
  }

  @Patch('password')
  password(@Req() req: AuthedRequest, @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>) {
    return this.auth.changePassword(req.user, body);
  }

  @Public()
  @Post('password-reset')
  @HttpCode(200)
  requestReset(@Req() req: Request, @Body(new ZodPipe(requestPasswordResetSchema)) body: RequestPasswordResetInput) {
    return this.auth.requestReset(req, body);
  }

  @Public()
  @Get('password-reset/:token')
  describeReset(@Param('token') token: string) {
    return this.auth.describeReset(token);
  }

  @Public()
  @Post('password-reset/:token')
  @HttpCode(200)
  reset(@Param('token') token: string, @Body(new ZodPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>) {
    return this.auth.resetPassword(token, body.password);
  }
}

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, TenantGuard, PlatformAdminGuard, { provide: APP_GUARD, useClass: SessionAuthGuard }],
  exports: [AuthService, SessionService, TenantGuard, PlatformAdminGuard],
})
export class AuthModule {}
