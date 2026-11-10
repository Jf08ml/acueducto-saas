import { z } from 'zod';

/** Acceso temporal de soporte: lo pide el superadmin y lo aprueba el acueducto. */
export const requestSupportSchema = z.object({
  reason: z.string().min(10, 'Explica para qué necesitas el acceso').max(500),
  scope: z.enum(['read', 'write']).default('read'),
  durationHours: z.number().int().min(1).max(72),
});
export type RequestSupportInput = z.infer<typeof requestSupportSchema>;

export const decideSupportSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), note: z.string().max(300).optional() }),
  z.object({ decision: z.literal('reject'), note: z.string().min(3).max(300) }),
]);

export const SUPPORT_SCOPE_LABEL: Record<string, string> = {
  read: 'Solo consultar',
  write: 'Consultar y modificar',
};

export const SUPPORT_STATUS_LABEL: Record<string, string> = {
  pending: 'Esperando aprobación',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  revoked: 'Revocado',
  expired: 'Vencido',
};

/** Estado efectivo (un permiso aprobado cuyo plazo pasó se muestra como vencido). */
export function supportGrantState(g: { status: string; expiresAt: string | Date | null }, now = new Date()): string {
  if (g.status === 'approved' && g.expiresAt && new Date(g.expiresAt).getTime() <= now.getTime()) return 'expired';
  return g.status;
}

/** Nombre legible de las acciones de la bitácora. Las que no estén aquí se muestran con su clave. */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Inicio de sesión',
  'auth.login_failed': 'Intento de inicio de sesión fallido',
  'auth.logout': 'Cierre de sesión',
  'auth.switch_org': 'Cambio de acueducto',
  'auth.password_changed': 'Cambio de contraseña',
  'auth.password_reset_requested': 'Solicitud de recuperación de contraseña',
  'auth.password_reset': 'Contraseña recuperada',
  'organization.registered': 'Registro del acueducto',
  'organization.active': 'Cuenta reactivada por la plataforma',
  'organization.suspended': 'Cuenta suspendida por la plataforma',
  'organization.deactivated': 'Cuenta desactivada por la plataforma',
  'setup.profile': 'Perfil regulatorio actualizado',
  'setup.tariff': 'Tarifa actualizada',
  'setup.branding': 'Marca actualizada',
  'setup.logo': 'Logo actualizado',
  'setup.completed': 'Configuración inicial completada',
  'subscribers.imported': 'Importación de suscriptores',
  'invitation.created': 'Invitación enviada',
  'invitation.resent': 'Invitación reenviada',
  'invitation.revoked': 'Invitación cancelada',
  'invitation.accepted': 'Invitación aceptada',
  'member.updated': 'Acceso de un usuario modificado',
  'member.removed': 'Usuario retirado',
  'receipts.pdf_generated': 'PDF de recibos generado',
  'billing.issued': 'Facturación emitida',
  'billing.voided': 'Facturación anulada',
  'payment.created': 'Pago registrado',
  'payment.voided': 'Pago anulado',
  'charge.created': 'Cargo adicional creado',
  'charge.voided': 'Cargo adicional anulado',
  'service.suspended': 'Servicio suspendido',
  'service.reconnected': 'Servicio reconectado',
  'collections.settings': 'Configuración de cobro actualizada',
  'compliance.updated': 'Obligación regulatoria actualizada',
  'domain.added': 'Dominio agregado',
  'domain.primary': 'Dominio principal cambiado',
  'domain.removed': 'Dominio eliminado',
  'meter.installed': 'Medidor instalado',
  'meter.removed': 'Medidor retirado',
  'meter.damaged': 'Medidor marcado como dañado',
  'readings.saved': 'Lecturas registradas',
  'subscriber.created': 'Suscriptor creado',
  'subscriber.updated': 'Suscriptor modificado',
  'saas.invoice_issued': 'Factura de la plataforma emitida',
  'saas.invoice_paid': 'Factura de la plataforma pagada',
  'saas.invoice_voided': 'Factura de la plataforma anulada',
  'saas.transfer_reported': 'Transferencia reportada',
  'saas.transfer_approved': 'Transferencia aprobada',
  'saas.transfer_rejected': 'Transferencia rechazada',
  'saas.mercadopago_started': 'Pago con Mercado Pago iniciado',
  'saas.subscription_past_due': 'Suscripción con pago pendiente',
  'saas.subscription_suspended': 'Cuenta en solo lectura por falta de pago',
  'saas.subscription_adjusted': 'Suscripción ajustada por la plataforma',
  'saas.settings_updated': 'Configuración de cobro actualizada',
  'saas.plan_updated': 'Plan actualizado',
  'support.requested': 'Acceso de soporte solicitado',
  'support.approved': 'Acceso de soporte aprobado',
  'support.rejected': 'Acceso de soporte rechazado',
  'support.revoked': 'Acceso de soporte revocado',
  'support.session_started': 'Soporte entró a la cuenta',
  'support.request': 'Consulta de soporte',
  'einvoice.config_updated': 'Configuración de facturación electrónica actualizada',
  'einvoice.sent': 'Factura electrónica enviada',
  'einvoice.failed': 'Factura electrónica con error',
};

export const AUDIT_CATEGORIES: { key: string; label: string; prefixes: string[] }[] = [
  { key: 'auth', label: 'Accesos', prefixes: ['auth.'] },
  { key: 'support', label: 'Soporte de AguaMata', prefixes: ['support.'] },
  { key: 'team', label: 'Usuarios', prefixes: ['invitation.', 'member.'] },
  { key: 'setup', label: 'Configuración', prefixes: ['setup.', 'domain.', 'collections.', 'compliance.', 'einvoice.'] },
  { key: 'operation', label: 'Suscriptores, medidores y lecturas', prefixes: ['subscriber', 'meter.', 'readings.'] },
  { key: 'billing', label: 'Facturación y recaudo', prefixes: ['billing.', 'payment.', 'receipts.', 'charge.', 'service.'] },
  { key: 'saas', label: 'Suscripción', prefixes: ['saas.', 'organization.'] },
];
