import {
  Controller, Get, Global, Injectable, Logger, Module, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, Param, ParseUUIDPipe,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScoped } from '../auth/decorators';
import { currentContext, requestContext } from '../common/request-context';

/** Varias instalaciones pueden compartir un Redis con nombres de cola distintos. */
const queueName = () => process.env.QUEUE_NAME ?? 'aguamata';

export interface JobContext<I> {
  /** id de la tarea en platform.background_jobs (null en tareas de sistema no rastreadas). */
  id: string | null;
  organizationId?: string;
  input: I;
  /** Avance 0-100 (lo ve el usuario). */
  progress(pct: number): Promise<void>;
}

export type JobHandler<I = any, R = any> = (job: JobContext<I>) => Promise<R>;

export interface EnqueueOptions {
  /** Corre con este tenant fijado (RLS). Por defecto, el del contexto actual. null = tarea de plataforma. */
  organizationId?: string | null;
  /** Guardar estado y resultado en platform.background_jobs para que el usuario lo siga. */
  tracked?: boolean;
  attempts?: number;
  delayMs?: number;
  /** Evita duplicados: BullMQ ignora una tarea con el mismo jobId mientras exista. */
  dedupeKey?: string;
}

interface Payload {
  trackedId: string | null;
  organizationId: string | null;
  userId: string | null;
  input: unknown;
}

/**
 * Cola de tareas en segundo plano.
 *  - Con Redis (REDIS_URL) usa BullMQ: reintentos con espera creciente, tareas programadas (cron) y un
 *    worker que puede correr en este mismo proceso (WORKER_ENABLED, por defecto sí) o en otro.
 *  - En pruebas (o QUEUE_DRIVER=inline) ejecuta la tarea en el acto: resultados deterministas sin Redis.
 * Cada tarea de un acueducto corre con su tenant fijado, así que RLS aplica igual que en una petición.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules: { type: string; pattern: string }[] = [];
  readonly driver: 'bullmq' | 'inline' =
    (process.env.QUEUE_DRIVER ?? (process.env.NODE_ENV === 'test' || !process.env.REDIS_URL ? 'inline' : 'bullmq')) === 'bullmq' ? 'bullmq' : 'inline';
  private connection?: IORedis;
  private workerConnection?: IORedis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(private readonly prisma: PrismaService) {}

  /** Cada módulo registra sus tareas en onModuleInit. */
  register<I, R>(type: string, handler: JobHandler<I, R>) {
    if (this.handlers.has(type)) throw new Error(`Tarea duplicada: ${type}`);
    this.handlers.set(type, handler as JobHandler);
  }

  /** Tarea de sistema periódica (cron, hora de Colombia). En modo inline no se programa. */
  schedule(type: string, pattern: string) {
    this.schedules.push({ type, pattern });
  }

  async onApplicationBootstrap() {
    if (this.driver !== 'bullmq') return;
    this.connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    this.queue = new Queue(queueName(), {
      connection: this.connection,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, backoff: { type: 'exponential', delay: 10_000 } },
    });
    for (const s of this.schedules) {
      await this.queue.upsertJobScheduler(`cron:${s.type}`, { pattern: s.pattern, tz: 'America/Bogota' }, {
        name: s.type, data: { trackedId: null, organizationId: null, userId: null, input: {} } satisfies Payload,
      });
    }
    if ((process.env.WORKER_ENABLED ?? 'true') === 'true') {
      this.workerConnection = this.connection.duplicate({ maxRetriesPerRequest: null });
      this.worker = new Worker(queueName(), (job) => this.process(job), {
        connection: this.workerConnection,
        concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
      });
      this.worker.on('failed', (job, err) => { if (job) void this.onFailed(job, err); });
      this.worker.on('error', (err) => this.log.error(`Worker: ${err.message}`));
      this.log.log(`Cola BullMQ lista (${this.handlers.size} tipos de tarea, ${this.schedules.length} programadas)`);
    }
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    // BullMQ no cierra las conexiones que recibe: se cierran aquí para que el proceso pueda terminar.
    await this.workerConnection?.quit().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
  }

  /** Encola una tarea. Devuelve el id rastreable (o null si no se rastrea). */
  async enqueue<I>(type: string, input: I, opts: EnqueueOptions = {}): Promise<{ id: string | null }> {
    if (!this.handlers.has(type)) throw new Error(`Tarea desconocida: ${type}`);
    const ctx = currentContext();
    const organizationId = opts.organizationId === undefined ? ctx.organizationId ?? null : opts.organizationId;
    const tracked = opts.tracked ?? true;
    const record = tracked
      ? await this.prisma.platform.backgroundJob.create({
          data: { type, organizationId, createdById: ctx.userId, input: input as Prisma.InputJsonValue },
        })
      : null;
    const payload: Payload = { trackedId: record?.id ?? null, organizationId, userId: ctx.userId ?? null, input };

    if (this.driver === 'inline') {
      await this.runInline(type, payload);
      return { id: record?.id ?? null };
    }
    await this.queue!.add(type, payload, {
      attempts: opts.attempts ?? 3,
      delay: opts.delayMs,
      jobId: opts.dedupeKey ?? record?.id,
    });
    return { id: record?.id ?? null };
  }

  /** Ejecuta ya una tarea programada (botón del superadmin, pruebas). */
  async runNow(type: string) {
    return this.enqueue(type, {}, { organizationId: null, tracked: true, attempts: 1 });
  }

  private async runInline(type: string, payload: Payload) {
    try {
      await this.execute(type, payload, 1);
    } catch (err: any) {
      await this.markFailed(payload.trackedId, err, 1);
      if (process.env.NODE_ENV !== 'test') this.log.error(`Tarea ${type} falló: ${err?.message ?? err}`);
    }
  }

  private process(job: Job<Payload>) {
    return this.execute(job.name, job.data, job.attemptsMade + 1);
  }

  private async execute(type: string, payload: Payload, attempt: number) {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Tarea desconocida: ${type}`);
    const { trackedId } = payload;
    if (trackedId) {
      await this.prisma.platform.backgroundJob.update({
        where: { id: trackedId }, data: { status: 'running', startedAt: new Date(), attempts: attempt, error: null },
      });
    }
    const progress = async (pct: number) => {
      if (trackedId) await this.prisma.platform.backgroundJob.update({ where: { id: trackedId }, data: { progress: Math.max(0, Math.min(100, Math.round(pct))) } });
    };
    // Mismo aislamiento que una petición: tenant fijado y usuario para la auditoría.
    const result = await requestContext.run(
      { organizationId: payload.organizationId ?? undefined, userId: payload.userId ?? undefined },
      () => handler({ id: trackedId, organizationId: payload.organizationId ?? undefined, input: payload.input, progress }),
    );
    if (trackedId) {
      await this.prisma.platform.backgroundJob.update({
        where: { id: trackedId },
        data: { status: 'done', progress: 100, finishedAt: new Date(), result: (result ?? null) as Prisma.InputJsonValue },
      });
    }
    return result;
  }

  private async onFailed(job: Job<Payload>, err: Error) {
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    this.log.error(`Tarea ${job.name} falló (intento ${job.attemptsMade}${final ? ', definitivo' : ''}): ${err.message}`);
    if (final) await this.markFailed(job.data.trackedId, err, job.attemptsMade);
    else if (job.data.trackedId) await this.prisma.platform.backgroundJob.update({ where: { id: job.data.trackedId }, data: { status: 'queued', error: err.message } });
  }

  private async markFailed(trackedId: string | null, err: any, attempts: number) {
    if (!trackedId) return;
    // Solo los errores pensados para el usuario (HttpException) se muestran tal cual.
    const message = typeof err?.getResponse === 'function' ? String(err.message) : 'La tarea falló. Intenta de nuevo o contacta a soporte';
    await this.prisma.platform.backgroundJob.update({
      where: { id: trackedId }, data: { status: 'failed', error: message, attempts, finishedAt: new Date() },
    });
  }

  /** Estado de una tarea del acueducto actual. */
  async get(id: string) {
    const job = await this.prisma.platform.backgroundJob.findFirst({
      where: { id, organizationId: currentContext().organizationId },
      select: { id: true, type: true, status: true, progress: true, result: true, error: true, createdAt: true, finishedAt: true },
    });
    if (!job) throw new NotFoundException();
    // La clave de almacenamiento de un archivo resultante no sale de la API (se descarga por /jobs/:id/file).
    const result = job.result as Record<string, any> | null;
    if (result?.file) {
      const { key: _key, ...file } = result.file;
      return { ...job, result: { ...result, file } };
    }
    return job;
  }
}

@Controller('jobs')
@TenantScoped()
class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(id);
  }
}

@Global()
@Module({ controllers: [JobsController], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
