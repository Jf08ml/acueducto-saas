import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import type { OrgRole } from '@agua-mata/shared';
import { TenantGuard } from './tenant.guard';
import { PlatformAdminGuard } from './platform-admin.guard';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';
export const ALLOW_READ_ONLY = 'allowWhenReadOnly';

/** Ruta sin autenticación (login, registro de acueducto). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Ruta de datos de un acueducto: exige membresía vigente y fija el tenant en el contexto. */
export const TenantScoped = (...roles: OrgRole[]) =>
  applyDecorators(SetMetadata(ROLES, roles), UseGuards(TenantGuard));

/**
 * Ruta que puede modificar datos aunque la cuenta esté en solo lectura por falta de pago
 * (p. ej. pagar la suscripción). Sin esto, en solo lectura solo se permiten consultas.
 */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_READ_ONLY, true);

/** Ruta del panel Superadmin: NO fija tenant, así que RLS oculta todos los datos de acueductos. */
export const PlatformAdmin = () => UseGuards(PlatformAdminGuard);
