import { z } from 'zod';
import { isValidNit } from './nit';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerOrganizationSchema = z
  .object({
    name: z.string().min(3),
    legalName: z.string().min(3),
    nit: z.string().regex(/^\d{6,15}$/, 'Solo dígitos, sin DV'),
    nitDv: z.number().int().min(0).max(9),
    department: z.string().min(2),
    municipality: z.string().min(2),
    organizationType: z.enum(['comunitario', 'asociacion_usuarios', 'junta_accion_comunal', 'empresa_servicios_publicos', 'municipio', 'otro']),
    estimatedSubscribers: z.number().int().min(0),
    contactEmail: z.string().email(),
    contactPhone: z.string().min(7),
    owner: z.object({
      fullName: z.string().min(3),
      email: z.string().email(),
      password: z.string().min(8),
    }),
  })
  .refine((v) => isValidNit(v.nit, v.nitDv), { message: 'Dígito de verificación del NIT incorrecto', path: ['nitDv'] });
export type RegisterOrganizationInput = z.infer<typeof registerOrganizationSchema>;

export const createSubscriberSchema = z.object({
  code: z.string().min(1),
  fullName: z.string().min(3),
  documentNumber: z.string().min(3),
  address: z.string().min(3),
  stratum: z.number().int().min(1).max(6).optional(),
  usage: z.enum(['residencial', 'comercial', 'industrial', 'oficial']).default('residencial'),
});
export type CreateSubscriberInput = z.infer<typeof createSubscriberSchema>;

export const updateSubscriberSchema = z.object({
  fullName: z.string().min(3).optional(),
  documentNumber: z.string().min(3).optional(),
  address: z.string().min(3).optional(),
  stratum: z.number().int().min(1).max(6).nullable().optional(),
  usage: z.enum(['residencial', 'comercial', 'industrial', 'oficial']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type UpdateSubscriberInput = z.infer<typeof updateSubscriberSchema>;
