import { ForbiddenException, Global, Injectable, Module } from '@nestjs/common';
import type { FeatureKey, LimitKey } from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface Entitlements {
  planCode: string | null;
  subscriptionStatus: string | null;
  features: Record<string, boolean>;
  limits: Record<string, number>; // -1 = ilimitado
}

const USABLE_STATUSES = ['trialing', 'active', 'past_due'] as const;

/**
 * Lo que una organización puede hacer = plan de su suscripción vigente + overrides no vencidos.
 * Todo sale de datos en la BD: un plan o promoción nuevos no requieren cambiar código.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  async forOrganization(organizationId: string): Promise<Entitlements> {
    const [subscription, overrides] = await Promise.all([
      this.prisma.platform.subscription.findFirst({
        where: { organizationId, status: { in: [...USABLE_STATUSES] } },
        orderBy: { createdAt: 'desc' },
        include: { plan: { include: { features: true, limits: true } } },
      }),
      this.prisma.platform.orgEntitlementOverride.findMany({
        where: { organizationId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      }),
    ]);

    const features: Record<string, boolean> = {};
    const limits: Record<string, number> = {};
    for (const f of subscription?.plan.features ?? []) features[f.featureKey] = f.enabled;
    for (const l of subscription?.plan.limits ?? []) limits[l.limitKey] = l.value;
    for (const o of overrides) {
      const [kind, key] = o.key.split(':');
      if (kind === 'feature') features[key] = o.value === 1;
      if (kind === 'limit') limits[key] = o.value;
    }

    return {
      planCode: subscription?.plan.code ?? null,
      subscriptionStatus: subscription?.status ?? null,
      features,
      limits,
    };
  }

  async assertFeature(organizationId: string, feature: FeatureKey) {
    const e = await this.forOrganization(organizationId);
    if (!e.features[feature]) {
      throw new ForbiddenException({ code: 'FEATURE_NOT_IN_PLAN', feature, message: 'Tu plan no incluye este módulo' });
    }
  }

  /** Bloquea crear un recurso nuevo si ya se alcanzó el límite. Nunca bloquea lectura ni exportación. */
  async assertWithinLimit(organizationId: string, limit: LimitKey, currentCount: number) {
    const e = await this.forOrganization(organizationId);
    const max = e.limits[limit];
    if (max === undefined) throw new ForbiddenException({ code: 'LIMIT_NOT_IN_PLAN', limit });
    if (max !== -1 && currentCount >= max) {
      throw new ForbiddenException({ code: 'PLAN_LIMIT_REACHED', limit, max, message: 'Alcanzaste el límite de tu plan' });
    }
  }
}

@Global()
@Module({ providers: [EntitlementsService], exports: [EntitlementsService] })
export class EntitlementsModule {}
