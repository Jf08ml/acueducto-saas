import { BadRequestException, Controller, Get, Injectable, Module, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { createSubscriberSchema, CreateSubscriberInput, SUBSCRIBER_IMPORT_COLUMNS } from '@agua-mata/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AuditService } from '../audit/audit.service';
import { TenantScoped } from '../auth/decorators';
import { currentContext } from '../common/request-context';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ImportIssue {
  row: number;
  field?: string;
  message: string;
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, '_');

/**
 * Importación de suscriptores desde Excel en dos pasos: validar (dryRun) y luego confirmar.
 * Es todo o nada: si hay un solo error no se importa ninguna fila.
 * TODO: mover a la cola de trabajos (BullMQ) cuando se implemente, para archivos grandes.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  async template(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('suscriptores');
    ws.columns = SUBSCRIBER_IMPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.key === 'address' ? 40 : 22 }));
    ws.getRow(1).font = { bold: true };
    ws.addRow({ code: '001', fullName: 'María Pérez Gómez', documentNumber: '12345678', address: 'Vereda El Encano, casa 3', stratum: 1 });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async parse(buffer: Buffer): Promise<{ rows: (CreateSubscriberInput & { row: number })[]; issues: ImportIssue[]; totalRows: number }> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as any);
    } catch {
      throw new BadRequestException('No se pudo leer el archivo. Usa la plantilla en formato .xlsx');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('El archivo no tiene hojas');

    const headerIndex = new Map<string, number>();
    ws.getRow(1).eachCell((cell, col) => headerIndex.set(normalize(cell.text ?? ''), col));
    const missing = SUBSCRIBER_IMPORT_COLUMNS.filter((c) => c.required && !headerIndex.has(c.header)).map((c) => c.header);
    if (missing.length) throw new BadRequestException(`Faltan columnas en la fila 1: ${missing.join(', ')}`);
    if (ws.actualRowCount - 1 > MAX_ROWS) throw new BadRequestException(`Máximo ${MAX_ROWS} filas por archivo`);

    const rows: (CreateSubscriberInput & { row: number })[] = [];
    const issues: ImportIssue[] = [];
    const seen = new Map<string, number>();
    let totalRows = 0;

    ws.eachRow((r, rowNumber) => {
      if (rowNumber === 1) return;
      const raw: Record<string, string> = {};
      for (const c of SUBSCRIBER_IMPORT_COLUMNS) {
        const col = headerIndex.get(c.header);
        raw[c.key] = col ? (r.getCell(col).text ?? '').trim() : '';
      }
      if (Object.values(raw).every((v) => v === '')) return; // fila vacía
      totalRows++;

      const candidate = { ...raw, stratum: raw.stratum === '' ? undefined : Number(raw.stratum) };
      const parsed = createSubscriberSchema.safeParse(candidate);
      if (!parsed.success) {
        for (const i of parsed.error.issues) issues.push({ row: rowNumber, field: String(i.path[0] ?? ''), message: i.message });
        return;
      }
      const prev = seen.get(parsed.data.code);
      if (prev) {
        issues.push({ row: rowNumber, field: 'code', message: `Código repetido (también en la fila ${prev})` });
        return;
      }
      seen.set(parsed.data.code, rowNumber);
      rows.push({ ...parsed.data, row: rowNumber });
    });
    return { rows, issues, totalRows };
  }

  async importSubscribers(file: Express.Multer.File | undefined, dryRun: boolean) {
    if (!file) throw new BadRequestException('Adjunta el archivo .xlsx');
    if (file.mimetype !== XLSX_MIME && !file.originalname.toLowerCase().endsWith('.xlsx')) {
      throw new BadRequestException('El archivo debe ser .xlsx');
    }
    const organizationId = currentContext().organizationId!;
    await this.entitlements.assertFeature(organizationId, 'excel_import');

    const { rows, issues, totalRows } = await this.parse(file.buffer);

    // Códigos que ya existen en ESTE acueducto (RLS limita la búsqueda al tenant actual).
    const existing = await this.prisma.tenant.subscriber.findMany({
      where: { code: { in: rows.map((r) => r.code) } },
      select: { code: true },
    });
    const taken = new Set(existing.map((e) => e.code));
    for (const r of rows) if (taken.has(r.code)) issues.push({ row: r.row, field: 'code', message: 'Ya existe un suscriptor con este código' });
    const valid = rows.filter((r) => !taken.has(r.code));

    const current = await this.prisma.tenant.subscriber.count();
    const ent = await this.entitlements.forOrganization(organizationId);
    const max = ent.limits.max_subscribers ?? 0;
    if (max !== -1 && current + valid.length > max) {
      issues.push({ row: 0, message: `El archivo supera el límite de tu plan: tienes ${current}, intentas agregar ${valid.length} y el máximo es ${max}` });
    }

    issues.sort((a, b) => a.row - b.row);
    const summary = { totalRows, validRows: valid.length, issues: issues.slice(0, 500), issueCount: issues.length };
    if (dryRun || issues.length) return { ...summary, imported: 0, dryRun };

    for (let i = 0; i < valid.length; i += 1000) {
      await this.prisma.tenant.subscriber.createMany({
        data: valid.slice(i, i + 1000).map(({ row: _row, ...s }) => ({ ...s, organizationId })),
      });
    }
    await this.audit.log({ action: 'subscribers.imported', entity: 'subscriber', data: { count: valid.length, file: file.originalname } });
    return { ...summary, imported: valid.length, dryRun: false };
  }
}

@Controller('imports/subscribers')
@TenantScoped('owner', 'admin')
class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('template')
  async template(@Res() res: Response) {
    const buf = await this.imports.template();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-suscriptores.xlsx"');
    res.send(buf);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Query('dryRun') dryRun?: string) {
    return this.imports.importSubscribers(file, dryRun !== 'false');
  }
}

@Module({ controllers: [ImportsController], providers: [ImportsService] })
export class ImportsModule {}
