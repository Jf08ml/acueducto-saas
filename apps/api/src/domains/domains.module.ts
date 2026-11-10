import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Global, HttpCode, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { promises as dns } from 'node:dns';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  classifyHost, DOMAIN_VERIFICATION_PREFIX, isValidHostname, normalizeHostname, tenantDefaultUrl,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { ZodPipe } from '../common/zod.pipe';
import { Public, TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';

const MAX_CUSTOM_DOMAINS = 3;
const CACHE_TTL_MS = 60_000;

export function platformOrigin(): string {
  return process.env.PLATFORM_WEB_ORIGIN ?? 'http://localhost:3000';
}
export function platformRootHost(): string {
  return new URL(platformOrigin()).hostname;
}

/** Dirección pública de un acueducto: su dominio principal verificado o el subdominio por defecto. */
export async function orgPublicUrl(prisma: PrismaService, organizationId: string) {
  const org = await prisma.platform.organization.findUniqueOrThrow({
    where: { id: organizationId },
    include: { domains: { where: { isPrimary: true, status: 'verified' } } },
  });
  return { org, url: org.domains[0] ? `https://${org.domains[0].hostname}` : tenantDefaultUrl(platformOrigin(), org.slug) };
}

/** Resolución DNS reemplazable en pruebas. */
export class DnsResolver {
  static resolveTxt: (name: string) => Promise<string[][]> = (name) => dns.resolveTxt(name);
}

type Branding = { primaryColor?: string; secondaryColor?: string; logoKey?: string };

@Injectable()
export class DomainsService {
  private originCache = new Map<string, { ok: boolean; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ───── Resolución pública de host → acueducto ─────

  /** Información pública (nombre y marca) del acueducto que corresponde a un host. Nunca datos privados. */
  async resolveHost(host: string) {
    const kind = classifyHost(host, platformRootHost());
    if (kind.kind === 'platform') return { kind: 'platform' as const, organization: null };

    const org =
      kind.kind === 'subdomain'
        ? await this.prisma.platform.organization.findUnique({ where: { slug: kind.slug } })
        : (await this.prisma.platform.organizationDomain.findFirst({
            where: { hostname: kind.hostname, status: 'verified' },
            include: { organization: true },
          }))?.organization ?? null;
    if (!org || org.status === 'deactivated') throw new NotFoundException('No hay un acueducto en esta dirección');

    const b = org.branding as Branding;
    return {
      kind: kind.kind,
      organization: {
        id: org.id, name: org.name, slug: org.slug, status: org.status, municipality: org.municipality, department: org.department,
        branding: { primaryColor: b.primaryColor, secondaryColor: b.secondaryColor, hasLogo: Boolean(b.logoKey) },
      },
    };
  }

  /** Para TLS bajo demanda (p. ej. Caddy "ask"): solo emitir certificados para hosts que existen. */
  async isServableHost(host: string) {
    try {
      await this.resolveHost(host);
      return true;
    } catch {
      return false;
    }
  }

  /** CORS: plataforma, subdominios de la plataforma y dominios propios verificados. */
  async isAllowedOrigin(origin: string | undefined): Promise<boolean> {
    if (!origin) return true;
    const cached = this.originCache.get(origin);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ok;

    let ok = false;
    try {
      const u = new URL(origin);
      const p = new URL(platformOrigin());
      const root = p.hostname;
      if (u.protocol === p.protocol && (u.hostname === root || u.hostname.endsWith(`.${root}`))) ok = true;
      else {
        ok = Boolean(await this.prisma.platform.organizationDomain.findFirst({ where: { hostname: u.hostname, status: 'verified' } }));
      }
    } catch {
      ok = false;
    }
    this.originCache.set(origin, { ok, at: Date.now() });
    return ok;
  }

  // ───── Gestión de dominios del acueducto actual ─────

  private orgId() {
    return currentContext().organizationId!;
  }

  private instructions(hostname: string, token: string) {
    return [
      { type: 'TXT', name: `${DOMAIN_VERIFICATION_PREFIX}.${hostname}`, value: token, purpose: 'Demuestra que el dominio es tuyo' },
      { type: 'CNAME', name: hostname, value: `tenants.${platformRootHost()}`, purpose: 'Dirige el tráfico a la plataforma' },
    ];
  }

  async list() {
    const org = await this.prisma.platform.organization.findUniqueOrThrow({ where: { id: this.orgId() } });
    const domains = await this.prisma.platform.organizationDomain.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
    const primary = domains.find((d) => d.isPrimary && d.status === 'verified');
    const defaultUrl = tenantDefaultUrl(platformOrigin(), org.slug);
    return {
      defaultUrl,
      primaryUrl: primary ? `https://${primary.hostname}` : defaultUrl,
      custom: domains.map((d) => ({
        id: d.id, hostname: d.hostname, status: d.status, isPrimary: d.isPrimary, verifiedAt: d.verifiedAt,
        lastCheckedAt: d.lastCheckedAt, lastError: d.lastError, dns: this.instructions(d.hostname, d.verificationToken),
      })),
    };
  }

  async add(rawHostname: string) {
    const organizationId = this.orgId();
    await this.entitlements.assertFeature(organizationId, 'custom_domain');
    const hostname = normalizeHostname(rawHostname);
    if (!isValidHostname(hostname)) throw new BadRequestException('Dominio inválido. Ejemplo: portal.miacueducto.org');
    const root = platformRootHost();
    if (hostname === root || hostname.endsWith(`.${root}`)) {
      throw new BadRequestException('Ese dominio pertenece a la plataforma; tu subdominio ya está incluido');
    }
    const count = await this.prisma.platform.organizationDomain.count({ where: { organizationId } });
    if (count >= MAX_CUSTOM_DOMAINS) throw new BadRequestException(`Máximo ${MAX_CUSTOM_DOMAINS} dominios propios`);
    if (await this.prisma.platform.organizationDomain.findUnique({ where: { hostname } })) {
      throw new ConflictException('Ese dominio ya está registrado');
    }
    const d = await this.prisma.platform.organizationDomain.create({
      data: { organizationId, hostname, verificationToken: `aguamata-${randomBytes(16).toString('hex')}` },
    });
    await this.audit.log({ action: 'domain.added', entity: 'organization_domain', entityId: d.id, data: { hostname } });
    return { id: d.id, hostname, status: d.status, dns: this.instructions(hostname, d.verificationToken) };
  }

  private async own(id: string) {
    const d = await this.prisma.platform.organizationDomain.findFirst({ where: { id, organizationId: this.orgId() } });
    if (!d) throw new NotFoundException();
    return d;
  }

  async verify(id: string) {
    const d = await this.own(id);
    let records: string[] = [];
    let lastError: string | null = null;
    try {
      records = (await DnsResolver.resolveTxt(`${DOMAIN_VERIFICATION_PREFIX}.${d.hostname}`)).map((r) => r.join(''));
    } catch (e: any) {
      lastError = e?.code === 'ENOTFOUND' || e?.code === 'ENODATA' ? 'No se encontró el registro TXT todavía' : 'No se pudo consultar el DNS';
    }
    const ok = records.includes(d.verificationToken);
    if (!ok && !lastError) lastError = 'El registro TXT existe pero el valor no coincide';

    const updated = await this.prisma.platform.organizationDomain.update({
      where: { id },
      data: ok
        ? { status: 'verified', verifiedAt: d.verifiedAt ?? new Date(), lastCheckedAt: new Date(), lastError: null }
        : { status: d.status === 'verified' ? 'verified' : 'failed', lastCheckedAt: new Date(), lastError },
    });
    this.originCache.clear();
    await this.audit.log({ action: ok ? 'domain.verified' : 'domain.verification_failed', entity: 'organization_domain', entityId: id });
    return { id, status: updated.status, lastError: updated.lastError };
  }

  async setPrimary(id: string) {
    const d = await this.own(id);
    if (d.status !== 'verified') throw new BadRequestException('Primero verifica el dominio');
    await this.prisma.platform.$transaction([
      this.prisma.platform.organizationDomain.updateMany({ where: { organizationId: d.organizationId }, data: { isPrimary: false } }),
      this.prisma.platform.organizationDomain.update({ where: { id }, data: { isPrimary: true } }),
    ]);
    await this.audit.log({ action: 'domain.primary', entity: 'organization_domain', entityId: id });
    return { ok: true };
  }

  async remove(id: string) {
    const d = await this.own(id);
    await this.prisma.platform.organizationDomain.delete({ where: { id } });
    this.originCache.clear();
    await this.audit.log({ action: 'domain.removed', entity: 'organization_domain', entityId: id, data: { hostname: d.hostname } });
  }
}

const addDomainSchema = z.object({ hostname: z.string().min(4).max(253) });

@Controller('domains')
@TenantScoped('owner', 'admin')
class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  list() {
    return this.domains.list();
  }

  @Post()
  add(@Body(new ZodPipe(addDomainSchema)) body: z.infer<typeof addDomainSchema>) {
    return this.domains.add(body.hostname);
  }

  @Post(':id/verify')
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.domains.verify(id);
  }

  @Post(':id/primary')
  primary(@Param('id', ParseUUIDPipe) id: string) {
    return this.domains.setPrimary(id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.domains.remove(id);
  }
}

@Controller('public')
class PublicHostController {
  constructor(private readonly domains: DomainsService) {}

  @Public()
  @Get('resolve-host')
  resolve(@Query('host') host?: string) {
    if (!host) throw new BadRequestException('Falta host');
    return this.domains.resolveHost(host);
  }

  /** Endpoint "ask" para TLS bajo demanda del proxy (Caddy/Traefik). */
  @Public()
  @Get('tls-ask')
  async tlsAsk(@Query('domain') domain?: string) {
    if (!domain || !(await this.domains.isServableHost(domain))) throw new NotFoundException();
    return { ok: true };
  }
}

@Global()
@Module({ controllers: [DomainsController, PublicHostController], providers: [DomainsService], exports: [DomainsService] })
export class DomainsModule {}
