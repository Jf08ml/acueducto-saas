import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, Module, NotFoundException, Param,
  ParseUUIDPipe, Post, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { decideSupportSchema, requestSupportSchema, RequestSupportInput, SUPPORT_SCOPE_LABEL } from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { emailLayout, MailService } from '../mail/mail.service';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformAdmin, TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';
import { orgPublicUrl, platformOrigin } from '../domains/domains.module';
import { Principal, SessionService } from '../auth/session.service';

const when = (d: Date) => d.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' });

/**
 * Acceso temporal de soporte. El superadmin NO ve datos de los acueductos salvo que el acueducto lo apruebe:
 *  1. El superadmin lo pide con motivo, alcance (consultar / modificar) y duración (1 a 72 horas).
 *  2. Un dueño o administrador del acueducto lo aprueba o lo rechaza. El plazo corre desde la aprobación.
 *  3. Quien lo pidió entra con una sesión de soporte que vence con el permiso. El TenantGuard revisa el permiso
 *     en cada petición y registra cada una en la auditoría del acueducto.
 *  4. El acueducto puede revocarlo en cualquier momento: las sesiones de soporte se cierran de inmediato.
 */
@Injectable()
export class SupportService {
  private readonly log = new Logger('Support');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly sessions: SessionService,
  ) {}

  // ───── Superadmin ─────

  async request(organizationId: string, input: RequestSupportInput) {
    const org = await this.prisma.platform.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundException();
    const open = await this.prisma.platform.supportAccessGrant.findFirst({
      where: { organizationId, OR: [{ status: 'pending' }, { status: 'approved', expiresAt: { gt: new Date() } }] },
    });
    if (open) throw new ConflictException(open.status === 'pending' ? 'Ya hay una solicitud pendiente para este acueducto' : 'Ya tienes un acceso vigente a este acueducto');
    const userId = currentContext().userId!;
    const grant = await this.prisma.platform.supportAccessGrant.create({
      data: { organizationId, requestedById: userId, reason: input.reason, scope: input.scope, durationHours: input.durationHours },
    });
    await this.audit.log({ action: 'support.requested', entity: 'support_grant', entityId: grant.id, organizationId, data: { reason: input.reason, scope: input.scope, durationHours: input.durationHours } });
    const requester = await this.prisma.platform.user.findUniqueOrThrow({ where: { id: userId }, select: { fullName: true } });
    await this.notifyOrg(organizationId, `Soporte de AguaMata pide acceso a ${org.name}`, [
      `${requester.fullName}, del equipo de soporte de AguaMata, pide acceso a la cuenta de ${org.name}.`,
      `Motivo: ${input.reason}`,
      `Alcance: ${SUPPORT_SCOPE_LABEL[input.scope]}, durante ${input.durationHours} hora(s) desde que lo apruebes. Todo lo que haga queda en la auditoría y puedes cortar el acceso cuando quieras.`,
    ]);
    return grant;
  }

  listForPlatform() {
    return this.prisma.platform.supportAccessGrant.findMany({
      orderBy: { createdAt: 'desc' }, take: 100,
      include: { organization: { select: { id: true, name: true } } },
    });
  }

  /** Entra a la cuenta del acueducto con una sesión de soporte (reemplaza la sesión actual del superadmin). */
  async enter(req: Request & { user: Principal }, res: Response, grantId: string) {
    const g = await this.prisma.platform.supportAccessGrant.findUnique({ where: { id: grantId } });
    if (!g) throw new NotFoundException();
    if (g.requestedById !== req.user.sub) throw new ForbiddenException('Solo quien pidió el acceso puede usarlo');
    if (g.status !== 'approved' || !g.expiresAt || g.expiresAt.getTime() <= Date.now()) throw new BadRequestException('El acceso no está aprobado o ya venció');
    const { token, session } = await this.sessions.create(req, req.user.sub, g.organizationId, g.id, g.expiresAt.getTime() - Date.now());
    await this.sessions.revoke(req.user.sid);
    this.sessions.setCookie(req, res, token);
    await this.audit.log({ action: 'support.session_started', entity: 'support_grant', entityId: g.id, organizationId: g.organizationId, data: { sessionId: session.id, scope: g.scope, expiresAt: g.expiresAt.toISOString() } });
    return { organizationId: g.organizationId, expiresAt: g.expiresAt, scope: g.scope };
  }

  // ───── Acueducto ─────

  async listForTenant() {
    const grants = await this.prisma.platform.supportAccessGrant.findMany({
      where: { organizationId: currentContext().organizationId }, orderBy: { createdAt: 'desc' }, take: 50,
    });
    const users = await this.prisma.platform.user.findMany({
      where: { id: { in: [...new Set(grants.flatMap((g) => [g.requestedById, g.decidedById].filter(Boolean) as string[]))] } },
      select: { id: true, fullName: true },
    });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    return grants.map((g) => ({ ...g, requestedBy: name.get(g.requestedById) ?? 'Soporte de AguaMata', decidedBy: g.decidedById ? name.get(g.decidedById) ?? null : null }));
  }

  private async tenantGrant(id: string) {
    const g = await this.prisma.platform.supportAccessGrant.findFirst({ where: { id, organizationId: currentContext().organizationId } });
    if (!g) throw new NotFoundException();
    return g;
  }

  async decide(id: string, input: z.infer<typeof decideSupportSchema>) {
    const { userId, supportGrantId } = currentContext();
    if (supportGrantId) throw new ForbiddenException('El soporte no puede aprobar sus propios accesos');
    const g = await this.tenantGrant(id);
    if (g.status !== 'pending') throw new ConflictException('Esta solicitud ya fue respondida');
    const now = new Date();
    const data = input.decision === 'approve'
      ? { status: 'approved', approvedById: userId, approvedAt: now, expiresAt: new Date(now.getTime() + g.durationHours * 3_600_000) }
      : { status: 'rejected' };
    const claimed = await this.prisma.platform.supportAccessGrant.updateMany({
      where: { id, status: 'pending' }, data: { ...data, decidedById: userId, decisionNote: input.note ?? null },
    });
    if (claimed.count !== 1) throw new ConflictException('Esta solicitud ya fue respondida');
    const updated = await this.prisma.platform.supportAccessGrant.findUniqueOrThrow({ where: { id } });
    await this.audit.log({ action: `support.${updated.status}`, entity: 'support_grant', entityId: id, data: { note: input.note ?? null, expiresAt: updated.expiresAt?.toISOString() ?? null } });
    await this.notifyPlatform(g.requestedById, updated.status === 'approved' ? 'Acceso de soporte aprobado' : 'Acceso de soporte rechazado', [
      updated.status === 'approved'
        ? `Aprobaron tu acceso de soporte (${SUPPORT_SCOPE_LABEL[g.scope]}). Vence el ${when(updated.expiresAt!)}.`
        : `Rechazaron tu solicitud de acceso de soporte${input.note ? `: ${input.note}` : '.'}`,
    ]);
    return updated;
  }

  /** Corta el acceso de inmediato: el permiso queda revocado y las sesiones de soporte se cierran. */
  async revoke(id: string) {
    const g = await this.tenantGrant(id);
    if (g.status !== 'approved' && g.status !== 'pending') throw new ConflictException('Este acceso ya no está vigente');
    await this.prisma.platform.supportAccessGrant.update({ where: { id }, data: { status: 'revoked', revokedAt: new Date(), decidedById: currentContext().userId } });
    const closed = await this.prisma.platform.session.updateMany({ where: { supportGrantId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ action: 'support.revoked', entity: 'support_grant', entityId: id, data: { sessionsClosed: closed.count } });
    return { ok: true };
  }

  // ───── Avisos ─────

  private async notifyOrg(organizationId: string, subject: string, paragraphs: string[]) {
    try {
      const members = await this.prisma.platform.membership.findMany({
        where: { organizationId, status: 'active', role: { in: ['owner', 'admin'] } }, include: { user: { select: { email: true } } },
      });
      const { url } = await orgPublicUrl(this.prisma, organizationId);
      for (const m of members) {
        await this.mail.send({
          to: m.user.email, subject, text: `${paragraphs.join('\n\n')}\n\nResponde la solicitud aquí: ${url}/auditoria`,
          html: emailLayout({ orgName: 'AguaMata', title: subject, paragraphs, cta: { label: 'Revisar la solicitud', url: `${url}/auditoria` } }),
        });
      }
    } catch (e: any) {
      this.log.error(`No se pudo avisar al acueducto ${organizationId}: ${e?.message ?? e}`);
    }
  }

  private async notifyPlatform(userId: string, subject: string, paragraphs: string[]) {
    try {
      const u = await this.prisma.platform.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!u) return;
      const url = `${platformOrigin()}/admin`;
      await this.mail.send({ to: u.email, subject, text: `${paragraphs.join('\n\n')}\n\n${url}`, html: emailLayout({ orgName: 'AguaMata', title: subject, paragraphs, cta: { label: 'Abrir el panel', url } }) });
    } catch (e: any) {
      this.log.error(`No se pudo avisar a soporte: ${e?.message ?? e}`);
    }
  }
}

type AuthedRequest = Request & { user: Principal };

@Controller('platform/support')
@PlatformAdmin()
class PlatformSupportController {
  constructor(private readonly support: SupportService) {}

  @Get('grants')
  list() {
    return this.support.listForPlatform();
  }

  @Post('organizations/:id/grants')
  request(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(requestSupportSchema)) body: RequestSupportInput) {
    return this.support.request(id, body);
  }

  @Post('grants/:id/enter')
  @HttpCode(200)
  enter(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.enter(req, res, id);
  }
}

@Controller('support/grants')
@TenantScoped('owner', 'admin')
class TenantSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list() {
    return this.support.listForTenant();
  }

  @Post(':id/decision')
  @HttpCode(200)
  decide(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideSupportSchema)) body: z.infer<typeof decideSupportSchema>) {
    return this.support.decide(id, body);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.revoke(id);
  }
}

@Module({ controllers: [PlatformSupportController, TenantSupportController], providers: [SupportService] })
export class SupportModule {}
