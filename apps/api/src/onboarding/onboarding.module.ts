import { Body, ConflictException, Controller, Injectable, Module, Post } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { DEFAULT_PLAN_CODE, RESERVED_SLUGS, registerOrganizationSchema, RegisterOrganizationInput, tenantDefaultUrl } from '@agua-mata/shared';
import { platformOrigin } from '../domains/domains.module';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { Public } from '../auth/decorators';

const TRIAL_PLAN_CODE = DEFAULT_PLAN_CODE;

function slugify(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Paso 1 del asistente: crea el acueducto, su dueño y una suscripción de prueba. */
  async register(input: RegisterOrganizationInput) {
    const db = this.prisma.platform;
    if (await db.organization.findUnique({ where: { nit: input.nit } })) {
      throw new ConflictException('Ya existe una organización con ese NIT');
    }
    const email = input.owner.email.toLowerCase();
    if (await db.user.findUnique({ where: { email } })) {
      throw new ConflictException('Ya existe un usuario con ese correo');
    }

    const plan = await db.plan.findUniqueOrThrow({ where: { code: TRIAL_PLAN_CODE } });
    const now = new Date();
    const trialEnd = new Date(now.getTime() + plan.trialDays * 86_400_000);
    // El slug es también el subdominio por defecto ({slug}.plataforma): único, sin palabras reservadas.
    const baseSlug = slugify(input.name) || 'acueducto';
    let slug = RESERVED_SLUGS.has(baseSlug) ? `${baseSlug}-${input.nit.slice(-4)}` : baseSlug;
    if (await db.organization.findUnique({ where: { slug } })) slug = `${baseSlug}-${input.nit.slice(-4)}`;
    if (await db.organization.findUnique({ where: { slug } })) slug = `${baseSlug}-${randomBytes(3).toString('hex')}`;

    const org = await db.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          slug,
          name: input.name,
          legalName: input.legalName,
          nit: input.nit,
          nitDv: input.nitDv,
          department: input.department,
          municipality: input.municipality,
          organizationType: input.organizationType,
          estimatedSubscribers: input.estimatedSubscribers,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
        },
      });
      const user = await tx.user.create({
        data: { email, fullName: input.owner.fullName, passwordHash: await bcrypt.hash(input.owner.password, 10) },
      });
      await tx.membership.create({ data: { userId: user.id, organizationId: org.id, role: 'owner' } });
      await tx.subscription.create({
        data: {
          organizationId: org.id,
          planId: plan.id,
          status: 'trialing',
          trialEndsAt: trialEnd,
          currentPeriodStart: now,
          currentPeriodEnd: trialEnd,
        },
      });
      return { org, user };
    });

    await this.audit.log({
      action: 'organization.registered',
      entity: 'organization',
      entityId: org.org.id,
      organizationId: org.org.id,
      actorUserId: org.user.id,
      data: { plan: plan.code, trialEndsAt: trialEnd.toISOString() },
    });

    return {
      organizationId: org.org.id,
      slug: org.org.slug,
      defaultUrl: tenantDefaultUrl(platformOrigin(), org.org.slug),
      trialEndsAt: trialEnd,
    };
  }
}

@Controller('onboarding')
class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Public()
  @Post('organizations')
  register(@Body(new ZodPipe(registerOrganizationSchema)) body: RegisterOrganizationInput) {
    return this.onboarding.register(body);
  }
}

@Module({ controllers: [OnboardingController], providers: [OnboardingService] })
export class OnboardingModule {}
