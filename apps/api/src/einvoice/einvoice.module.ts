import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Module, OnModuleInit, Param, Post, Put } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  buildEInvoicePayload, EInvoiceConfigInput, einvoiceConfigSchema, EInvoicePayload, nextEInvoiceNumber, periodSchema, resolutionWarnings,
} from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JobContext, JobsService } from '../jobs/jobs.module';
import { ZodPipe } from '../common/zod.pipe';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';
import { decryptSecret, encryptSecret } from '../common/secrets';

export const EINVOICE_SEND_JOB = 'einvoice.send_period';
const SENDABLE = ['pending', 'error'];

export interface EInvoiceResult {
  status: 'accepted' | 'rejected';
  documentKey?: string;
  qrUrl?: string;
  providerRef?: string;
  message?: string;
  raw?: unknown;
}

/** Proveedor tecnológico. Para conectar uno real se implementa esta interfaz y se registra en PROVIDERS. */
export interface EInvoiceProvider {
  readonly key: string;
  send(payload: EInvoicePayload, ctx: { technicalKey: string | null }): Promise<EInvoiceResult>;
}

/**
 * Proveedor SIMULADO: acepta el documento y devuelve un código SHA-384 parecido al CUFE/CUDE.
 * Sirve para probar el flujo de punta a punta. NO transmite nada a la DIAN y sus documentos no tienen validez.
 */
export class SimulatedProvider implements EInvoiceProvider {
  readonly key = 'simulated';
  async send(p: EInvoicePayload, ctx: { technicalKey: string | null }): Promise<EInvoiceResult> {
    if (p.environment !== 'habilitacion') return { status: 'rejected', message: 'El proveedor simulado solo funciona en habilitación' };
    if (!p.customer.documentNumber) return { status: 'rejected', message: 'El suscriptor no tiene número de documento' };
    const parts = [p.fullNumber, p.issueDate, '00:00:00-05:00', p.totals.total.toFixed(2), p.issuer.nit, p.customer.documentNumber, ctx.technicalKey ?? '', '2'];
    const documentKey = createHash('sha384').update(parts.join('')).digest('hex');
    return {
      status: 'accepted', documentKey,
      qrUrl: `https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${documentKey}`,
      providerRef: `SIM-${p.fullNumber}`, message: 'Simulado: no se transmitió a la DIAN',
    };
  }
}

const PROVIDERS: Record<string, EInvoiceProvider> = { simulated: new SimulatedProvider() };

/**
 * Facturación electrónica (BASE). Al emitir una facturación, si está activa, se encola una tarea que:
 *  1. asigna a cada factura un número del rango autorizado (en orden, bajo bloqueo, sin huecos ni repetidos),
 *  2. arma el documento neutro y lo envía al proveedor,
 *  3. guarda el resultado (CUFE/CUDE, QR o el error) para mostrarlo en el recibo y reintentar si falla.
 * Anular una facturación ya aceptada no borra el documento: queda «requiere nota crédito» (pendiente de implementar).
 */
@Injectable()
export class EInvoiceService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.jobs.register<{ period: string }, any>(EINVOICE_SEND_JOB, (job) => this.sendPeriodJob(job));
  }

  /** Solo para pruebas: reemplaza un proveedor. */
  useProvider(p: EInvoiceProvider) {
    PROVIDERS[p.key] = p;
  }

  private config() {
    return this.prisma.tenant.eInvoiceConfig.findFirst();
  }

  async getConfig() {
    const c = await this.config();
    if (!c) return { config: null, lastNumber: null, warnings: [] as string[] };
    const last = await this.prisma.tenant.eInvoiceDocument.aggregate({ where: { prefix: c.prefix }, _max: { number: true } });
    const d = (x: Date) => x.toISOString().slice(0, 10);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    return {
      config: {
        enabled: c.enabled, provider: c.provider, environment: c.environment, documentType: c.documentType,
        resolution: { number: c.resolutionNumber, date: d(c.resolutionDate), prefix: c.prefix, rangeFrom: c.rangeFrom, rangeTo: c.rangeTo, validFrom: d(c.validFrom), validTo: d(c.validTo) },
        hasTechnicalKey: Boolean(c.technicalKeyEncrypted),
      },
      lastNumber: last._max.number,
      warnings: resolutionWarnings({ rangeFrom: c.rangeFrom, rangeTo: c.rangeTo, validTo: d(c.validTo) }, last._max.number, today),
    };
  }

  async saveConfig(input: EInvoiceConfigInput) {
    const organizationId = currentContext().organizationId!;
    const r = input.resolution;
    const data = {
      enabled: input.enabled, provider: input.provider, environment: input.environment, documentType: input.documentType,
      resolutionNumber: r.number, resolutionDate: new Date(r.date), prefix: r.prefix, rangeFrom: r.rangeFrom, rangeTo: r.rangeTo,
      validFrom: new Date(r.validFrom), validTo: new Date(r.validTo),
      ...(input.technicalKey ? { technicalKeyEncrypted: encryptSecret(input.technicalKey) } : {}),
    };
    await this.prisma.tenant.eInvoiceConfig.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
    const { technicalKey: _secret, ...logged } = input;
    await this.audit.log({ action: 'einvoice.config_updated', entity: 'einvoice_config', data: { ...logged, technicalKeyChanged: Boolean(input.technicalKey) } as Prisma.InputJsonValue });
    return this.getConfig();
  }

  /** Lo llama la facturación al emitir un período. No hace nada si la facturación electrónica está apagada. */
  async periodIssued(period: string) {
    const c = await this.config();
    if (!c?.enabled) return null;
    return this.jobs.enqueue(EINVOICE_SEND_JOB, { period }, { attempts: 3 });
  }

  /** Al anular una facturación: lo no enviado se anula; lo ya aceptado necesita nota crédito. */
  async periodVoided(period: string) {
    await this.prisma.tenant.eInvoiceDocument.updateMany({ where: { period, status: { in: ['pending', 'error', 'rejected'] }, invoice: { status: 'void' } }, data: { status: 'void' } });
    await this.prisma.tenant.eInvoiceDocument.updateMany({ where: { period, status: 'accepted', invoice: { status: 'void' } }, data: { status: 'requires_credit_note' } });
  }

  async retry(period: string) {
    const c = await this.config();
    if (!c?.enabled) throw new BadRequestException('La facturación electrónica está desactivada');
    return this.jobs.enqueue(EINVOICE_SEND_JOB, { period }, { attempts: 1 });
  }

  async periodStatus(period: string) {
    const [groups, problems] = await Promise.all([
      this.prisma.tenant.eInvoiceDocument.groupBy({ by: ['status'], where: { period }, _count: true }),
      this.prisma.tenant.eInvoiceDocument.findMany({
        where: { period, status: { in: ['error', 'rejected', 'requires_credit_note'] } }, orderBy: { number: 'asc' }, take: 50,
        select: { id: true, prefix: true, number: true, status: true, lastError: true, invoice: { select: { number: true, subscriberSnapshot: true } } },
      }),
    ]);
    const c = await this.config();
    return { enabled: Boolean(c?.enabled), environment: c?.environment ?? null, provider: c?.provider ?? null, counts: Object.fromEntries(groups.map((g) => [g.status, g._count])), problems };
  }

  // ───── Tarea ─────

  private async sendPeriodJob(job: JobContext<{ period: string }>) {
    const c = await this.config();
    if (!c?.enabled) return { skipped: true };
    const provider = PROVIDERS[c.provider];
    if (!provider) throw new BadRequestException(`Proveedor de facturación electrónica desconocido: ${c.provider}`);
    const org = await this.prisma.platform.organization.findUniqueOrThrow({ where: { id: job.organizationId! } });
    const resolution = {
      number: c.resolutionNumber, date: c.resolutionDate.toISOString().slice(0, 10), prefix: c.prefix, rangeFrom: c.rangeFrom, rangeTo: c.rangeTo,
      validFrom: c.validFrom.toISOString().slice(0, 10), validTo: c.validTo.toISOString().slice(0, 10),
    };
    const cfg = { documentType: c.documentType as EInvoiceConfigInput['documentType'], environment: c.environment as EInvoiceConfigInput['environment'], resolution };

    // 1) Numerar las facturas que aún no tienen documento (todo o nada, bajo bloqueo por acueducto).
    const created = await this.prisma.tenantTransaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`einvoice:${org.id}`}))`;
      const invoices = await tx.invoice.findMany({
        where: { period: job.input.period, status: { not: 'void' }, electronicDocument: null },
        orderBy: { number: 'asc' },
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!invoices.length) return 0;
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
      if (today < resolution.validFrom || today > resolution.validTo) throw new BadRequestException('La resolución de numeración no está vigente');
      let last = (await tx.eInvoiceDocument.aggregate({ where: { prefix: c.prefix }, _max: { number: true } }))._max.number;
      for (const inv of invoices) {
        let number: number;
        try {
          number = nextEInvoiceNumber(last, resolution);
        } catch (e: any) {
          // Mensaje pensado para el usuario (rango agotado): se muestra tal cual en el estado de la tarea.
          throw new BadRequestException(e.message);
        }
        last = number;
        const payload = buildEInvoicePayload({ config: cfg, number, org, invoice: inv });
        await tx.eInvoiceDocument.create({
          data: {
            organizationId: org.id, invoiceId: inv.id, period: inv.period, documentType: c.documentType, environment: c.environment, provider: c.provider,
            prefix: c.prefix, number, payload: payload as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return invoices.length;
    });

    // 2) Enviar lo pendiente o lo que falló antes.
    const technicalKey = c.technicalKeyEncrypted ? decryptSecret(c.technicalKeyEncrypted) : null;
    const docs = await this.prisma.tenant.eInvoiceDocument.findMany({ where: { period: job.input.period, status: { in: SENDABLE } }, orderBy: { number: 'asc' } });
    const summary = { created, sent: 0, accepted: 0, rejected: 0, errors: 0 };
    for (const [i, d] of docs.entries()) {
      try {
        const r = await provider.send(d.payload as unknown as EInvoicePayload, { technicalKey });
        await this.prisma.tenant.eInvoiceDocument.update({
          where: { id: d.id },
          data: {
            status: r.status, documentKey: r.documentKey, qrUrl: r.qrUrl, providerRef: r.providerRef, response: (r.raw ?? { message: r.message ?? null }) as Prisma.InputJsonValue,
            attempts: { increment: 1 }, lastError: r.status === 'rejected' ? r.message ?? 'Rechazada' : null, sentAt: new Date(),
            acceptedAt: r.status === 'accepted' ? new Date() : null,
          },
        });
        summary.sent++;
        if (r.status === 'accepted') summary.accepted++;
        else summary.rejected++;
      } catch (e: any) {
        summary.errors++;
        await this.prisma.tenant.eInvoiceDocument.update({ where: { id: d.id }, data: { status: 'error', attempts: { increment: 1 }, lastError: String(e?.message ?? e).slice(0, 500) } });
      }
      if (i % 20 === 0) await job.progress(((i + 1) / docs.length) * 95);
    }
    await this.audit.log({ action: summary.errors || summary.rejected ? 'einvoice.failed' : 'einvoice.sent', entity: 'billing_period', data: { period: job.input.period, ...summary } });
    return summary;
  }

  /** Documento electrónico de una factura, para imprimir el código en el recibo. */
  forInvoice(invoiceId: string) {
    return this.prisma.tenant.eInvoiceDocument.findFirst({ where: { invoiceId }, select: { status: true, documentKey: true, prefix: true, number: true, qrUrl: true, environment: true } });
  }
}

@Controller('einvoice')
@TenantScoped('owner', 'admin')
class EInvoiceController {
  constructor(private readonly einvoice: EInvoiceService) {}

  @Get('config')
  config() {
    return this.einvoice.getConfig();
  }

  @Put('config')
  save(@Body(new ZodPipe(einvoiceConfigSchema)) body: EInvoiceConfigInput) {
    return this.einvoice.saveConfig(body);
  }

  @Get('periods/:period')
  status(@Param('period', new ZodPipe(periodSchema)) period: string) {
    return this.einvoice.periodStatus(period);
  }

  @Post('periods/:period/retry')
  @HttpCode(200)
  retry(@Param('period', new ZodPipe(periodSchema)) period: string) {
    return this.einvoice.retry(period);
  }
}

@Module({ controllers: [EInvoiceController], providers: [EInvoiceService], exports: [EInvoiceService] })
export class EInvoiceModule {}
