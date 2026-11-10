/**
 * Cola de tareas: cada tarea corre con su tenant fijado (RLS), guarda avance y resultado,
 * y un error no rompe la petición que la encoló.
 */
import { BadRequestException, INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/main';
import { JobsService } from '../src/jobs/jobs.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { currentContext, runAsTenant } from '../src/common/request-context';

const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });

describe('Cola de tareas', () => {
  let app: INestApplication;
  let jobs: JobsService;
  let orgId = '';

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    jobs = app.get(JobsService);
    const prisma = app.get(PrismaService);
    jobs.register('test.count', async (job) => {
      await job.progress(50);
      return { org: currentContext().organizationId, subscribers: await prisma.tenant.subscriber.count() };
    });
    jobs.register('test.fail', async () => { throw new BadRequestException('Dato inválido para la tarea'); });
    jobs.register('test.crash', async () => { throw new Error('detalle interno'); });
    const org = await owner.organization.findFirstOrThrow({ select: { id: true } });
    orgId = org.id;
  });

  afterAll(async () => {
    await owner.backgroundJob.deleteMany({ where: { type: { startsWith: 'test.' } } });
    await Promise.all([owner.$disconnect(), app?.close()]);
  });

  it('en pruebas usa el modo inline', () => {
    expect(jobs.driver).toBe('inline');
  });

  it('corre con el tenant de quien la encola y guarda el resultado', async () => {
    const { id } = await runAsTenant(orgId, () => jobs.enqueue('test.count', {}));
    const row = await owner.backgroundJob.findUniqueOrThrow({ where: { id: id! } });
    expect(row).toMatchObject({ status: 'done', progress: 100, organizationId: orgId });
    expect((row.result as any).org).toBe(orgId);
    expect((row.result as any).subscribers).toBe(await owner.subscriber.count({ where: { organizationId: orgId } }));
  });

  it('sin tenant, RLS no deja ver datos de ningún acueducto', async () => {
    const { id } = await jobs.enqueue('test.count', {}, { organizationId: null });
    const row = await owner.backgroundJob.findUniqueOrThrow({ where: { id: id! } });
    expect((row.result as any).subscribers).toBe(0);
  });

  it('un error queda registrado: mensaje para el usuario solo si es intencional', async () => {
    const a = await runAsTenant(orgId, () => jobs.enqueue('test.fail', {}));
    expect(await owner.backgroundJob.findUniqueOrThrow({ where: { id: a.id! } })).toMatchObject({ status: 'failed', error: 'Dato inválido para la tarea' });
    const b = await runAsTenant(orgId, () => jobs.enqueue('test.crash', {}));
    const row = await owner.backgroundJob.findUniqueOrThrow({ where: { id: b.id! } });
    expect(row.status).toBe('failed');
    expect(row.error).not.toContain('detalle interno');
  });

  it('no acepta tipos de tarea desconocidos', async () => {
    await expect(jobs.enqueue('test.nope', {})).rejects.toThrow('Tarea desconocida');
  });
});
