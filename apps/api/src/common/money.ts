import { Prisma } from '@prisma/client';

/** Estados de factura con saldo por cobrar. */
export const OPEN_STATUSES = ['issued', 'partial'];

/**
 * Serializa las operaciones de dinero de UN acueducto dentro de la transacción (pagos, anulaciones,
 * emisión y anulación de facturación, suspensiones, cargos). Evita que dos cajeros apliquen dos veces
 * la misma deuda o repitan número.
 */
export async function lockMoney(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId} || ':money'))`;
}
