import {
  BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put, Res,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import {
  brandingSchema, BrandingInput, orgProfileSchema, OrgProfileInput, suggestedBasicConsumptionM3, tariffSchema, TariffInput,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { ComplianceModule, ComplianceService } from '../compliance/compliance.module';
import { ZodPipe } from '../common/zod.pipe';
import { Public, TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';

const LOGO_TYPES: Record<string, { ext: string; magic: number[] }> = {
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'image/webp': { ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46] },
};
const MAX_LOGO_BYTES = 1024 * 1024;

type Branding = { primaryColor?: string; secondaryColor?: string; receiptFooter?: string; logoKey?: string; logoType?: string };

/** Pasos del asistente de configuración inicial, posteriores al registro. */
@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly compliance: ComplianceService,
  ) {}

  private orgId() {
    return currentContext().organizationId!;
  }

  async state() {
    const id = this.orgId();
    const [org, tariff, subscribers, compliance] = await Promise.all([
      this.prisma.platform.organization.findUniqueOrThrow({ where: { id } }),
      this.prisma.tenant.tariffSchedule.findFirst({ where: { isActive: true }, orderBy: { effectiveFrom: 'desc' } }),
      this.prisma.tenant.subscriber.count(),
      this.prisma.tenant.complianceItem.count(),
    ]);
    const branding = org.branding as Branding;
    const steps = {
      profile: Boolean(org.legalNature && org.providerType && org.areaType),
      tariff: Boolean(tariff),
      branding: Boolean(branding.primaryColor),
      subscribers: subscribers > 0,
    };
    return {
      organization: {
        id: org.id, name: org.name, status: org.status, organizationType: org.organizationType, legalNature: org.legalNature,
        providerType: org.providerType, areaType: org.areaType, altitudeMasl: org.altitudeMasl, estimatedSubscribers: org.estimatedSubscribers,
        onboardingCompletedAt: org.onboardingCompletedAt,
        branding: { primaryColor: branding.primaryColor, secondaryColor: branding.secondaryColor, receiptFooter: branding.receiptFooter, hasLogo: Boolean(branding.logoKey) },
      },
      tariff,
      suggestedBasicConsumptionM3: org.altitudeMasl !== null ? suggestedBasicConsumptionM3(org.altitudeMasl) : null,
      complianceItems: compliance,
      subscriberCount: subscribers,
      steps,
      canComplete: steps.profile && steps.tariff,
    };
  }

  async saveProfile(input: OrgProfileInput) {
    await this.prisma.platform.organization.update({ where: { id: this.orgId() }, data: input });
    const sync = await this.compliance.syncForCurrentOrg();
    await this.audit.log({ action: 'setup.profile', entity: 'organization', entityId: this.orgId(), data: { ...input, compliance: sync } });
    return { compliance: sync };
  }

  /** Crea una nueva tarifa vigente y desactiva las anteriores (se conservan como historial). */
  async saveTariff(input: TariffInput) {
    const organizationId = this.orgId();
    await this.prisma.tenant.tariffSchedule.updateMany({ where: { isActive: true }, data: { isActive: false } });
    const tariff = await this.prisma.tenant.tariffSchedule.create({
      data: { ...input, organizationId, effectiveFrom: new Date(input.effectiveFrom) },
    });
    await this.audit.log({ action: 'setup.tariff', entity: 'tariff_schedule', entityId: tariff.id });
    return tariff;
  }

  async saveBranding(input: BrandingInput) {
    const org = await this.prisma.platform.organization.findUniqueOrThrow({ where: { id: this.orgId() } });
    const branding: Branding = { ...(org.branding as Branding), ...input };
    await this.prisma.platform.organization.update({ where: { id: org.id }, data: { branding: branding as Prisma.InputJsonValue } });
    await this.audit.log({ action: 'setup.branding', entity: 'organization', entityId: org.id, data: { ...input } });
    return { ok: true };
  }

  async saveLogo(file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Adjunta el archivo del logo');
    const type = LOGO_TYPES[file.mimetype];
    if (!type || !type.magic.every((b, i) => file.buffer[i] === b)) {
      throw new BadRequestException('El logo debe ser PNG, JPG o WEBP');
    }
    const org = await this.prisma.platform.organization.findUniqueOrThrow({ where: { id: this.orgId() } });
    const key = this.storage.orgKey(org.id, 'branding', `logo.${type.ext}`);
    await this.storage.put(key, file.buffer, file.mimetype);
    const branding: Branding = { ...(org.branding as Branding), logoKey: key, logoType: file.mimetype };
    await this.prisma.platform.organization.update({ where: { id: org.id }, data: { branding: branding as Prisma.InputJsonValue } });
    await this.audit.log({ action: 'setup.logo', entity: 'organization', entityId: org.id, data: { bytes: file.size } });
    return { ok: true };
  }

  async complete() {
    const s = await this.state();
    if (!s.canComplete) throw new BadRequestException('Completa al menos el perfil regulatorio y la tarifa');
    const org = await this.prisma.platform.organization.update({
      where: { id: this.orgId() },
      data: { onboardingCompletedAt: new Date(), ...(s.organization.status === 'onboarding' ? { status: 'active' } : {}) },
    });
    await this.audit.log({ action: 'setup.completed', entity: 'organization', entityId: org.id });
    return { status: org.status };
  }

  /** Logo para recibos y encabezados. Público a propósito: aparece en documentos impresos. */
  async logo(organizationId: string) {
    const org = await this.prisma.platform.organization.findUnique({ where: { id: organizationId }, select: { branding: true } });
    const b = org?.branding as Branding | undefined;
    if (!b?.logoKey || !b.logoType) return null;
    const data = await this.storage.get(b.logoKey);
    return data ? { data, type: b.logoType } : null;
  }
}

@Controller('setup')
@TenantScoped('owner', 'admin')
class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('state')
  state() {
    return this.setup.state();
  }

  @Put('profile')
  profile(@Body(new ZodPipe(orgProfileSchema)) body: OrgProfileInput) {
    return this.setup.saveProfile(body);
  }

  @Put('tariff')
  tariff(@Body(new ZodPipe(tariffSchema)) body: TariffInput) {
    return this.setup.saveTariff(body);
  }

  @Put('branding')
  branding(@Body(new ZodPipe(brandingSchema)) body: BrandingInput) {
    return this.setup.saveBranding(body);
  }

  @Post('branding/logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_LOGO_BYTES } }))
  logo(@UploadedFile() file?: Express.Multer.File) {
    return this.setup.saveLogo(file);
  }

  @Post('complete')
  complete() {
    return this.setup.complete();
  }
}

@Controller('public/orgs')
class PublicBrandingController {
  constructor(private readonly setup: SetupService) {}

  @Public()
  @Get(':id/logo')
  async logo(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const logo = await this.setup.logo(id);
    if (!logo) throw new NotFoundException();
    res.setHeader('Content-Type', logo.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(logo.data);
  }
}

@Module({ imports: [ComplianceModule], controllers: [SetupController, PublicBrandingController], providers: [SetupService] })
export class SetupModule {}
