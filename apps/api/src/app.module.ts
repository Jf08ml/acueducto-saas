import { Controller, Get, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './common/request-context';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { EntitlementsModule } from './entitlements/entitlements.service';
import { OnboardingModule } from './onboarding/onboarding.module';
import { SubscribersModule } from './subscribers/subscribers.module';
import { PlatformModule } from './platform/platform.module';
import { Public } from './auth/decorators';
import { MeModule } from './me/me.module';
import { StorageModule } from './storage/storage.service';
import { SetupModule } from './setup/setup.module';
import { ComplianceModule } from './compliance/compliance.module';
import { ImportsModule } from './imports/imports.module';
import { DomainsModule } from './domains/domains.module';
import { MetersModule } from './meters/meters.module';
import { BillingModule } from './billing/billing.module';
import { ReceivablesModule } from './receivables/receivables.module';

@Controller('health')
class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok' };
  }
}

function contextMiddleware(req: Request, _res: Response, next: NextFunction) {
  requestContext.run({ ip: req.ip }, () => next());
}

@Module({
  imports: [PrismaModule, AuditModule, AuthModule, EntitlementsModule, OnboardingModule, SubscribersModule, PlatformModule, MeModule, StorageModule, ComplianceModule, SetupModule, ImportsModule, DomainsModule, MetersModule, BillingModule, ReceivablesModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(contextMiddleware).forRoutes('{*splat}');
  }
}
