import {
  Body, Controller, Get, Headers, HttpCode, Logger, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import {
  adjustSubscriptionSchema, manualPaymentSchema, reportTransferSchema, reviewTransferSchema, SaasSettings, saasSettingsSchema, updatePlanSchema,
  voidSaasInvoiceSchema,
} from '@agua-mata/shared';
import { ZodPipe } from '../common/zod.pipe';
import { AllowWhenReadOnly, PlatformAdmin, Public, TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';
import { JobsService } from '../jobs/jobs.module';
import { SAAS_DAILY_JOB, SaasService } from './saas.service';
import { verifyMpSignature } from './mercadopago';

function sendProof(res: Response, p: { data: Buffer; type: string; name: string }) {
  res.setHeader('Content-Type', p.type);
  res.setHeader('Content-Disposition', `inline; filename="${p.name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(p.data);
}

/** El acueducto ve y paga su suscripción. Funciona aunque la cuenta esté en solo lectura (para poder pagar). */
@Controller('subscription')
@TenantScoped('owner', 'admin')
@AllowWhenReadOnly()
class TenantSubscriptionController {
  constructor(private readonly saas: SaasService) {}

  @Get()
  overview() {
    return this.saas.tenantOverview();
  }

  @Post('invoices/:id/mercadopago')
  mercadopago(@Param('id', ParseUUIDPipe) id: string) {
    return this.saas.startMercadoPago(id);
  }

  @Post('invoices/:id/mercadopago/sync')
  @HttpCode(200)
  sync(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ paymentId: z.string().regex(/^\d{1,30}$/) }))) body: { paymentId: string }) {
    return this.saas.syncMercadoPago(id, body.paymentId);
  }

  @Post('invoices/:id/transfer')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  transfer(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: unknown) {
    return this.saas.reportTransfer(id, file, new ZodPipe(reportTransferSchema).transform(body));
  }

  @Get('payments/:id/proof')
  async proof(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendProof(res, await this.saas.proof(id, { organizationId: currentContext().organizationId }));
  }
}

/** Superadmin: plan, configuración de cobro, transferencias por revisar, facturas y ajustes manuales. */
@Controller('platform/saas')
@PlatformAdmin()
class PlatformSaasController {
  constructor(
    private readonly saas: SaasService,
    private readonly jobs: JobsService,
  ) {}

  @Get()
  overview() {
    return this.saas.adminOverview();
  }

  @Put('settings')
  settings(@Body(new ZodPipe(saasSettingsSchema)) body: SaasSettings) {
    return this.saas.updateSettings(body);
  }

  @Patch('plans/:id')
  plan(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updatePlanSchema)) body: z.infer<typeof updatePlanSchema>) {
    return this.saas.updatePlan(id, body);
  }

  @Post('payments/:id/review')
  @HttpCode(200)
  review(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reviewTransferSchema)) body: z.infer<typeof reviewTransferSchema>) {
    return this.saas.reviewTransfer(id, body);
  }

  @Get('payments/:id/proof')
  async proof(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendProof(res, await this.saas.proof(id, {}));
  }

  @Post('invoices/:id/manual-payment')
  @HttpCode(200)
  manual(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(manualPaymentSchema)) body: z.infer<typeof manualPaymentSchema>) {
    return this.saas.recordManualPayment(id, body);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  void(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidSaasInvoiceSchema)) body: z.infer<typeof voidSaasInvoiceSchema>) {
    return this.saas.voidInvoice(id, body.reason);
  }

  @Patch('organizations/:id/subscription')
  adjust(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(adjustSubscriptionSchema)) body: z.infer<typeof adjustSubscriptionSchema>) {
    return this.saas.adjustSubscription(id, body);
  }

  /** Corre ya la revisión diaria (además de la programada a las 6:00 a. m.). */
  @Post('run-daily')
  runDaily() {
    return this.jobs.runNow(SAAS_DAILY_JOB);
  }
}

/** Notificaciones de Mercado Pago. Siempre responde 200 rápido; el pago se verifica consultando su API. */
@Controller('public/payments/mercadopago')
class MercadoPagoWebhookController {
  private readonly log = new Logger('MercadoPago');
  constructor(private readonly saas: SaasService) {}

  @Public()
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Query() query: Record<string, string>,
    @Body() body: any,
    @Headers('x-signature') signature?: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    const type = query.type ?? query.topic ?? body?.type;
    const dataId = String(query['data.id'] ?? body?.data?.id ?? '');
    if (type !== 'payment' || !/^\d{1,30}$/.test(dataId)) return { ok: true };
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (secret && !verifyMpSignature({ signature, requestId, dataId, secret })) {
      this.log.warn(`Webhook con firma inválida (pago ${dataId})`);
      return { ok: true };
    }
    try {
      await this.saas.processMercadoPagoPayment(dataId);
    } catch (e: any) {
      this.log.error(`No se pudo procesar el pago ${dataId}: ${e?.message ?? e}`);
    }
    return { ok: true };
  }
}

@Module({
  controllers: [TenantSubscriptionController, PlatformSaasController, MercadoPagoWebhookController],
  providers: [SaasService],
  exports: [SaasService],
})
export class SaasModule {}
