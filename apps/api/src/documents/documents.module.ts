import { Controller, Get, Injectable, Module, NotFoundException, OnModuleInit, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { periodSchema } from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { JobContext, JobsService } from '../jobs/jobs.module';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';
import { PdfIssuer, renderReceiptsPdf } from './receipt-pdf';

const PERIOD_PDF_JOB = 'receipts.period_pdf';
type PeriodPdfInput = { period: string };

/** Archivo que produce una tarea: la web lo descarga con GET /jobs/:id/file. La clave nunca sale de la API. */
export interface JobFile {
  key: string;
  name: string;
  contentType: string;
}

/** PDF generados en el servidor: un recibo al instante y los de un período completo como tarea en la cola. */
@Injectable()
export class DocumentsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.jobs.register<PeriodPdfInput, { file: JobFile; pages: number }>(PERIOD_PDF_JOB, (job) => this.periodPdfJob(job));
  }

  private async issuer(): Promise<PdfIssuer> {
    const org = await this.prisma.platform.organization.findUniqueOrThrow({ where: { id: currentContext().organizationId! } });
    const b = org.branding as { primaryColor?: string; receiptFooter?: string; logoKey?: string };
    return {
      name: org.name, legalName: org.legalName, nit: `${org.nit}-${org.nitDv}`, municipality: org.municipality, department: org.department,
      contactPhone: org.contactPhone, contactEmail: org.contactEmail, primaryColor: b.primaryColor, receiptFooter: b.receiptFooter,
      logo: b.logoKey ? await this.storage.get(b.logoKey) : null,
    };
  }

  private invoiceQuery = { include: { lines: { orderBy: { sortOrder: 'asc' as const } }, electronicDocument: { select: { status: true, documentKey: true, prefix: true, number: true } } } };

  /** El recibo impreso lleva el número y el código del documento electrónico cuando fue aceptado. */
  private withElectronic<T extends { electronicDocument: { status: string; documentKey: string | null; prefix: string; number: number } | null }>(inv: T) {
    const e = inv.electronicDocument;
    return { ...inv, electronic: e && e.status === 'accepted' ? { cufe: e.documentKey, status: e.status, number: `${e.prefix}${e.number}` } : null };
  }

  async invoicePdf(id: string) {
    const inv = await this.prisma.tenant.invoice.findUnique({ where: { id }, ...this.invoiceQuery });
    if (!inv) throw new NotFoundException();
    const pdf = await renderReceiptsPdf(await this.issuer(), [this.withElectronic(inv)]);
    return { pdf, name: `recibo-${inv.period}-${inv.number}.pdf` };
  }

  async enqueuePeriodPdf(period: string) {
    const exists = await this.prisma.tenant.billingPeriod.findFirst({ where: { period }, select: { id: true } });
    if (!exists) throw new NotFoundException('Ese período no se ha facturado');
    return this.jobs.enqueue<PeriodPdfInput>(PERIOD_PDF_JOB, { period }, { attempts: 2 });
  }

  private async periodPdfJob(job: JobContext<PeriodPdfInput>) {
    const { period } = job.input;
    const invoices = await this.prisma.tenant.invoice.findMany({
      where: { period, status: { not: 'void' } },
      orderBy: { number: 'asc' },
      take: 10_000,
      ...this.invoiceQuery,
    });
    let last = 0;
    const pdf = await renderReceiptsPdf(await this.issuer(), invoices.map((i) => this.withElectronic(i)), (n) => {
      const pct = Math.floor((n / Math.max(1, invoices.length)) * 90);
      if (pct >= last + 10) { last = pct; void job.progress(pct); }
    });
    const key = this.storage.orgKey(job.organizationId!, 'documents', `recibos-${period}-${job.id}.pdf`);
    await this.storage.put(key, pdf, 'application/pdf');
    await this.audit.log({ action: 'receipts.pdf_generated', entity: 'billing_period', data: { period, invoices: invoices.length, bytes: pdf.length } });
    return { file: { key, name: `recibos-${period}.pdf`, contentType: 'application/pdf' }, pages: invoices.length };
  }

  /** Archivo producido por una tarea del acueducto actual. */
  async jobFile(jobId: string) {
    const job = await this.prisma.platform.backgroundJob.findFirst({ where: { id: jobId, organizationId: currentContext().organizationId, status: 'done' } });
    const file = (job?.result as { file?: JobFile } | null)?.file;
    if (!file) throw new NotFoundException();
    const data = await this.storage.get(file.key);
    if (!data) throw new NotFoundException('El archivo ya no está disponible. Genéralo de nuevo');
    return { data, file };
  }
}

function sendFile(res: Response, data: Buffer, name: string, contentType: string, inline = false) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(data);
}

@Controller()
@TenantScoped()
class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get('invoices/:id/pdf')
  async invoicePdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { pdf, name } = await this.docs.invoicePdf(id);
    sendFile(res, pdf, name, 'application/pdf', true);
  }

  @Post('billing/periods/:period/receipts/pdf')
  periodPdf(@Param('period', new ZodPipe(periodSchema)) period: string) {
    return this.docs.enqueuePeriodPdf(period);
  }

  @Get('jobs/:id/file')
  async jobFile(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, file } = await this.docs.jobFile(id);
    sendFile(res, data, file.name, file.contentType);
  }
}

@Module({ controllers: [DocumentsController], providers: [DocumentsService], exports: [DocumentsService] })
export class DocumentsModule {}
