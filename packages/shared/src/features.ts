/**
 * Catálogo de módulos y límites. Los planes guardan estas claves como DATOS en la BD;
 * agregar un plan nuevo no requiere cambiar código, solo filas en platform.plan_features / plan_limits.
 */
export const FEATURES = [
  'subscribers',
  'meters',
  'billing',
  'payments',
  'receivables',
  'accounting',
  'documents',
  'reports',
  'automations',
  'integrations',
  'excel_import',
] as const;
export type FeatureKey = (typeof FEATURES)[number];

export const LIMITS = [
  'max_subscribers',
  'max_admin_users',
  'storage_mb',
  'documents_per_month',
  'automations',
  'integrations',
] as const;
export type LimitKey = (typeof LIMITS)[number];

export const ORG_ROLES = ['owner', 'admin', 'operator', 'reader'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
