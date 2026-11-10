import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { currentContext } from '../common/request-context';

export interface AuditEntry {
  action: string;
  entity?: string;
  entityId?: string;
  data?: Prisma.InputJsonValue;
  organizationId?: string;
  actorUserId?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry) {
    const ctx = currentContext();
    // Lo que se hace durante una sesión de soporte queda marcado con el permiso que la respalda.
    let data = entry.data;
    if (ctx.supportGrantId && entry.action !== 'support.request') {
      data = (data && typeof data === 'object' && !Array.isArray(data) ? { ...(data as object), viaSupportGrant: ctx.supportGrantId } : { value: data ?? null, viaSupportGrant: ctx.supportGrantId }) as Prisma.InputJsonValue;
    }
    await this.prisma.platform.auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        data,
        organizationId: entry.organizationId ?? ctx.organizationId,
        actorUserId: entry.actorUserId ?? ctx.userId,
        ip: ctx.ip,
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
