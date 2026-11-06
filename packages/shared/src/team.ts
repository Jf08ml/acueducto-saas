import { z } from 'zod';

/** Roles del personal del acueducto, de mayor a menor. */
export const ROLE_INFO = [
  { role: 'owner', label: 'Dueño', description: 'Todo, incluido gestionar a otros dueños, la suscripción y el dominio.' },
  { role: 'admin', label: 'Administrador', description: 'Todo excepto gestionar dueños: configuración, facturación, anulaciones y usuarios.' },
  { role: 'operator', label: 'Operador', description: 'Suscriptores, medidores, lecturas y registro de pagos. No factura ni anula.' },
  { role: 'reader', label: 'Consulta', description: 'Solo consulta: ve la información pero no la modifica.' },
] as const;
export type Role = (typeof ROLE_INFO)[number]['role'];
const roles = ROLE_INFO.map((r) => r.role) as [Role, ...Role[]];
export const ROLE_LABEL = Object.fromEntries(ROLE_INFO.map((r) => [r.role, r.label])) as Record<string, string>;

export const INVITATION_TTL_DAYS = 7;

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Correo inválido'),
  role: z.enum(roles),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const updateMemberSchema = z
  .object({ role: z.enum(roles).optional(), status: z.enum(['active', 'disabled']).optional() })
  .refine((v) => v.role || v.status, { message: 'Nada que cambiar' });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

const password = z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(128);

export const acceptInvitationSchema = z.object({
  /** Solo si la persona aún no tiene cuenta. */
  fullName: z.string().min(3).max(120).optional(),
  password,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: password })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'La nueva contraseña debe ser distinta', path: ['newPassword'] });

/** Reglas de gestión de miembros (se aplican en la API; la UI las usa para no mostrar acciones imposibles). */
export function canManageMember(actorRole: string, targetRole: string, isSelf: boolean): boolean {
  if (isSelf) return false;
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole !== 'owner';
  return false;
}
export function canAssignRole(actorRole: string, role: string): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return role !== 'owner';
  return false;
}
