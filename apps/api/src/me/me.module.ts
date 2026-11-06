import { Controller, Get, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';

@Controller('me')
class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Organización activa, su branding, el rol del usuario y lo que su plan permite. */
  @Get('organization')
  @TenantScoped()
  async organization() {
    const { organizationId, role, userId } = currentContext();
    const [org, user, membership] = await Promise.all([
      this.prisma.platform.organization.findUniqueOrThrow({
        where: { id: organizationId! },
        select: { id: true, name: true, slug: true, status: true, branding: true, municipality: true, department: true, onboardingCompletedAt: true },
      }),
      this.prisma.platform.user.findUniqueOrThrow({ where: { id: userId! }, select: { id: true, email: true, fullName: true } }),
      this.prisma.platform.membership.findUniqueOrThrow({ where: { userId_organizationId: { userId: userId!, organizationId: organizationId! } }, select: { id: true } }),
    ]);
    // No exponer claves internas de almacenamiento: solo colores, pie de recibo y si hay logo.
    const b = (org.branding ?? {}) as Record<string, string | undefined>;
    const branding = { primaryColor: b.primaryColor, secondaryColor: b.secondaryColor, receiptFooter: b.receiptFooter, hasLogo: Boolean(b.logoKey) };
    return {
      organization: { ...org, branding }, role, user, membershipId: membership.id,
      entitlements: await this.entitlements.forOrganization(organizationId!),
    };
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
