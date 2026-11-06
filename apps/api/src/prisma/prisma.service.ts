import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { currentContext } from '../common/request-context';

/**
 * Dos caras del mismo cliente:
 *  - `platform`: acceso al plano de control (organizaciones, planes, auditoría).
 *    Sobre tablas de `tenant.*` NO ve nada, porque no fija app.current_org y RLS filtra todo.
 *  - `tenant`: envuelve CADA consulta en una transacción que primero fija
 *    app.current_org = organización del contexto. Si no hay organización, fija '' → RLS devuelve 0 filas.
 *    Falla cerrado: un olvido nunca expone datos de otro acueducto.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly platform = new PrismaClient();
  readonly tenant = buildTenantClient(this.platform);

  async onModuleInit() {
    await this.platform.$connect();
  }

  async onModuleDestroy() {
    await this.platform.$disconnect();
  }
}

function buildTenantClient(base: PrismaClient) {
  return base.$extends({
    name: 'tenant-rls',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const orgId = currentContext().organizationId ?? '';
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('app.current_org', ${orgId}, TRUE)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof buildTenantClient>;
