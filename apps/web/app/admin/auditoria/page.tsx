'use client';

import { AUDIT_CATEGORIES } from '@agua-mata/shared';
import { AdminShell } from '@/components/admin-shell';
import { AuditLog } from '@/components/audit-log';
import { PageHeader } from '@/components/ui';

const PLATFORM_CATEGORIES = AUDIT_CATEGORIES.filter((c) => c.key === 'support' || c.key === 'saas' || c.key === 'auth');

/** Bitácora de la plataforma: cobro, estado de las cuentas y soporte. La operación de cada acueducto es privada. */
export default function AdminAuditoriaPage() {
  return (
    <AdminShell>
      <PageHeader title="Auditoría" description="Acciones de la plataforma: cobro, estado de las cuentas y accesos de soporte. La operación de cada acueducto no se muestra aquí." />
      <AuditLog path="/platform/audit" showOrganization categories={PLATFORM_CATEGORIES} />
    </AdminShell>
  );
}
