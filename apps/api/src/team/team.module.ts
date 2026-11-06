import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import {
  acceptInvitationSchema, AcceptInvitationInput, canAssignRole, canManageMember, INVITATION_TTL_DAYS, inviteSchema, InviteInput,
  ROLE_LABEL, tenantDefaultUrl, updateMemberSchema, UpdateMemberInput,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { emailLayout, MailService } from '../mail/mail.service';
import { ZodPipe } from '../common/zod.pipe';
import { Public, TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';
import { platformOrigin } from '../domains/domains.module';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Personal del acueducto. Las tablas son del plano de control (platform.*), así que CADA consulta
 * filtra explícitamente por la organización del contexto.
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly mail: MailService,
  ) {}

  private ctx() {
    const { organizationId, userId, role } = currentContext();
    return { organizationId: organizationId!, userId: userId!, role: role! };
  }

  /** Dirección pública del acueducto: dominio principal verificado o subdominio por defecto. */
  private async orgUrl(organizationId: string) {
    const org = await this.prisma.platform.organization.findUniqueOrThrow({
      where: { id: organizationId },
      include: { domains: { where: { isPrimary: true, status: 'verified' } } },
    });
    return { org, url: org.domains[0] ? `https://${org.domains[0].hostname}` : tenantDefaultUrl(platformOrigin(), org.slug) };
  }

  async list() {
    const { organizationId } = this.ctx();
    const [members, invitations] = await Promise.all([
      this.prisma.platform.membership.findMany({
        where: { organizationId },
        include: { user: { select: { id: true, email: true, fullName: true, lastLoginAt: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.platform.invitation.findMany({
        where: { organizationId, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      }),
    ]);
    const now = Date.now();
    return {
      members: members.map((m) => ({ id: m.id, role: m.role, status: m.status, createdAt: m.createdAt, user: m.user })),
      invitations: invitations.map((i) => ({ ...i, expired: i.expiresAt.getTime() < now })),
    };
  }

  /** Personal activo + invitaciones vigentes: lo que cuenta para el límite `max_admin_users` del plan. */
  private async seatsInUse(organizationId: string) {
    const [members, invites] = await Promise.all([
      this.prisma.platform.membership.count({ where: { organizationId, status: 'active' } }),
      this.prisma.platform.invitation.count({ where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    return members + invites;
  }

  private async issueToken(invitationId: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);
    await this.prisma.platform.invitation.update({ where: { id: invitationId }, data: { tokenHash: hashToken(token), expiresAt } });
    return { token, expiresAt };
  }

  async invite(input: InviteInput) {
    const { organizationId, userId, role } = this.ctx();
    if (!canAssignRole(role, input.role)) throw new ForbiddenException('No puedes invitar con ese rol');

    const existingUser = await this.prisma.platform.user.findUnique({ where: { email: input.email } });
    if (existingUser && (await this.prisma.platform.membership.findUnique({ where: { userId_organizationId: { userId: existingUser.id, organizationId } } }))) {
      throw new ConflictException('Esa persona ya hace parte del acueducto');
    }
    const pending = await this.prisma.platform.invitation.findFirst({ where: { organizationId, email: input.email, acceptedAt: null, revokedAt: null } });
    if (pending) throw new ConflictException('Ya hay una invitación pendiente para ese correo. Puedes reenviarla');
    await this.entitlements.assertWithinLimit(organizationId, 'max_admin_users', await this.seatsInUse(organizationId));

    const inv = await this.prisma.platform.invitation.create({
      data: { organizationId, email: input.email, role: input.role, invitedById: userId, tokenHash: `pending-${randomBytes(8).toString('hex')}`, expiresAt: new Date() },
    });
    return this.deliver(inv.id, 'invitation.created');
  }

  /** Genera un enlace nuevo (el anterior deja de servir) y lo "envía". */
  async resend(id: string) {
    const { organizationId } = this.ctx();
    const inv = await this.prisma.platform.invitation.findFirst({ where: { id, organizationId, acceptedAt: null, revokedAt: null } });
    if (!inv) throw new NotFoundException();
    return this.deliver(inv.id, 'invitation.resent');
  }

  private async deliver(invitationId: string, action: string) {
    const { organizationId } = this.ctx();
    const { token, expiresAt } = await this.issueToken(invitationId);
    const inv = await this.prisma.platform.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    const { org, url } = await this.orgUrl(organizationId);
    const inviteUrl = `${url}/invitacion?token=${token}`;
    const intro = `Te invitaron a unirte al equipo de ${org.name} en AguaMata como ${ROLE_LABEL[inv.role]}.`;
    const expiry = `El enlace es personal, sirve una sola vez y vence en ${INVITATION_TTL_DAYS} días.`;
    const sent = await this.mail.send(
      {
        to: inv.email,
        replyTo: org.contactEmail,
        subject: `Invitación a ${org.name}`,
        text: `${intro}\n\nCrea tu acceso aquí: ${inviteUrl}\n\n${expiry}`,
        html: emailLayout({
          orgName: org.name, color: (org.branding as { primaryColor?: string }).primaryColor, title: 'Te invitaron a un acueducto',
          paragraphs: [intro, expiry], cta: { label: 'Crear mi acceso', url: inviteUrl },
        }),
      },
      org.name,
    );
    await this.audit.log({ action, entity: 'invitation', entityId: inv.id, data: { email: inv.email, role: inv.role, emailDelivered: sent.delivered, provider: sent.provider } });
    return { id: inv.id, email: inv.email, role: inv.role, inviteUrl, expiresAt, emailSent: sent.delivered, emailError: sent.error };
  }

  async revoke(id: string) {
    const { organizationId } = this.ctx();
    const inv = await this.prisma.platform.invitation.findFirst({ where: { id, organizationId, acceptedAt: null, revokedAt: null } });
    if (!inv) throw new NotFoundException();
    await this.prisma.platform.invitation.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.log({ action: 'invitation.revoked', entity: 'invitation', entityId: id, data: { email: inv.email } });
  }

  private async target(id: string) {
    const { organizationId, userId, role } = this.ctx();
    const m = await this.prisma.platform.membership.findFirst({ where: { id, organizationId }, include: { user: { select: { email: true } } } });
    if (!m) throw new NotFoundException();
    if (m.userId === userId) throw new ForbiddenException('No puedes cambiar tu propio acceso. Pídeselo a otro administrador');
    if (!canManageMember(role, m.role, false)) throw new ForbiddenException('Solo un dueño puede gestionar a otro dueño');
    return m;
  }

  /** Siempre debe quedar al menos un dueño activo. */
  private async assertOwnerRemains(organizationId: string, excludingMembershipId: string) {
    const others = await this.prisma.platform.membership.count({ where: { organizationId, role: 'owner', status: 'active', id: { not: excludingMembershipId } } });
    if (others === 0) throw new BadRequestException('El acueducto debe conservar al menos un dueño activo');
  }

  async update(id: string, input: UpdateMemberInput) {
    const { organizationId, role } = this.ctx();
    const m = await this.target(id);
    if (input.role && !canAssignRole(role, input.role)) throw new ForbiddenException('No puedes asignar ese rol');
    const losesOwner = m.role === 'owner' && ((input.role && input.role !== 'owner') || input.status === 'disabled');
    if (losesOwner) await this.assertOwnerRemains(organizationId, m.id);
    if (input.status === 'active' && m.status !== 'active') {
      await this.entitlements.assertWithinLimit(organizationId, 'max_admin_users', await this.seatsInUse(organizationId));
    }
    const updated = await this.prisma.platform.membership.update({ where: { id }, data: input });
    await this.audit.log({ action: 'member.updated', entity: 'membership', entityId: id, data: { email: m.user.email, from: { role: m.role, status: m.status }, to: input } });
    return { id: updated.id, role: updated.role, status: updated.status };
  }

  async remove(id: string) {
    const { organizationId } = this.ctx();
    const m = await this.target(id);
    if (m.role === 'owner') await this.assertOwnerRemains(organizationId, m.id);
    await this.prisma.platform.membership.delete({ where: { id } });
    await this.audit.log({ action: 'member.removed', entity: 'membership', entityId: id, data: { email: m.user.email, role: m.role } });
  }

  // ───── Público: aceptar invitación ─────

  private async findValid(token: string) {
    const inv = await this.prisma.platform.invitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { organization: true } });
    if (!inv || inv.revokedAt) throw new NotFoundException('La invitación no existe o fue cancelada');
    if (inv.acceptedAt) throw new BadRequestException('Esta invitación ya fue usada');
    if (inv.expiresAt.getTime() < Date.now()) throw new BadRequestException('La invitación venció. Pide que te la reenvíen');
    if (inv.organization.status === 'deactivated') throw new NotFoundException('La organización no está disponible');
    return inv;
  }

  async describe(token: string) {
    const inv = await this.findValid(token);
    const b = inv.organization.branding as { primaryColor?: string; logoKey?: string };
    const userExists = Boolean(await this.prisma.platform.user.findUnique({ where: { email: inv.email } }));
    return {
      email: inv.email, role: inv.role, roleLabel: ROLE_LABEL[inv.role], expiresAt: inv.expiresAt, userExists,
      organization: { id: inv.organization.id, name: inv.organization.name, branding: { primaryColor: b.primaryColor, hasLogo: Boolean(b.logoKey) } },
    };
  }

  async accept(token: string, input: AcceptInvitationInput) {
    const inv = await this.findValid(token);
    const result = await this.prisma.platform.$transaction(async (tx) => {
      // Marcar primero: si dos pestañas aceptan a la vez, solo una gana.
      const claimed = await tx.invitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException('Esta invitación ya fue usada');

      let user = await tx.user.findUnique({ where: { email: inv.email } });
      if (user) {
        if (!(await bcrypt.compare(input.password, user.passwordHash))) {
          throw new BadRequestException('Ya tienes una cuenta con este correo: escribe tu contraseña actual');
        }
      } else {
        if (!input.fullName) throw new BadRequestException('Escribe tu nombre completo');
        user = await tx.user.create({ data: { email: inv.email, fullName: input.fullName, passwordHash: await bcrypt.hash(input.password, 10) } });
      }
      const exists = await tx.membership.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: inv.organizationId } } });
      if (exists) throw new ConflictException('Ya haces parte de este acueducto');
      await tx.membership.create({ data: { userId: user.id, organizationId: inv.organizationId, role: inv.role } });
      return user;
    });
    await this.audit.log({ action: 'invitation.accepted', entity: 'invitation', entityId: inv.id, organizationId: inv.organizationId, actorUserId: result.id, data: { email: inv.email, role: inv.role } });
    return { ok: true, email: inv.email, organizationId: inv.organizationId };
  }
}

@Controller('team')
@TenantScoped('owner', 'admin')
class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  list() {
    return this.team.list();
  }

  @Post('invitations')
  invite(@Body(new ZodPipe(inviteSchema)) body: InviteInput) {
    return this.team.invite(body);
  }

  @Post('invitations/:id/resend')
  resend(@Param('id', ParseUUIDPipe) id: string) {
    return this.team.resend(id);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.team.revoke(id);
  }

  @Patch('members/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateMemberSchema)) body: UpdateMemberInput) {
    return this.team.update(id, body);
  }

  @Delete('members/:id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.team.remove(id);
  }
}

@Controller('public/invitations')
class PublicInvitationsController {
  constructor(private readonly team: TeamService) {}

  @Public()
  @Get(':token')
  describe(@Param('token') token: string) {
    return this.team.describe(token);
  }

  @Public()
  @Post(':token/accept')
  accept(@Param('token') token: string, @Body(new ZodPipe(acceptInvitationSchema)) body: AcceptInvitationInput) {
    return this.team.accept(token, body);
  }
}

@Module({ controllers: [TeamController, PublicInvitationsController], providers: [TeamService] })
export class TeamModule {}
