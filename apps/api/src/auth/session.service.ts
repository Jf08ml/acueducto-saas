import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export const SESSION_COOKIE = 'am_sid';
/** Encabezado que la web envía en toda petición que modifica datos (protección CSRF con cookies). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'aguamata';

/** Sin actividad durante este tiempo, la sesión vence. */
const IDLE_MS = 8 * 3_600_000;
/** Duración máxima de una sesión aunque se use todo el tiempo. */
const ABSOLUTE_MS = 7 * 86_400_000;
/** No escribir en la BD en cada petición: solo si la última marca tiene más de esto. */
const TOUCH_EVERY_MS = 5 * 60_000;

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Quién hace la petición. Lo fija SessionAuthGuard en req.user. */
export interface Principal {
  /** id del usuario */
  sub: string;
  /** id de la sesión */
  sid: string;
  /** acueducto activo de la sesión */
  orgId?: string;
  /** superadmin de la plataforma */
  pa?: boolean;
  /** permiso de soporte que respalda la sesión */
  supportGrantId?: string;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function cookieSecure(req: Request) {
  if (process.env.COOKIE_SECURE) return process.env.COOKIE_SECURE === 'true';
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

/**
 * Sesiones guardadas en la BD (platform.sessions). La cookie es httpOnly (el JavaScript de la página no la
 * puede leer), SameSite=Lax y de host: cada dirección (plataforma, subdominio o dominio propio) tiene la suya.
 */
@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(req: Request, userId: string, organizationId?: string | null, supportGrantId?: string, ttlMs = IDLE_MS) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const session = await this.prisma.platform.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        organizationId: organizationId ?? null,
        supportGrantId,
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null,
        expiresAt: new Date(now + ttlMs),
      },
    });
    return { token, session };
  }

  setCookie(req: Request, res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure(req),
      path: '/',
      maxAge: ABSOLUTE_MS,
    });
  }

  clearCookie(req: Request, res: Response) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), path: '/' });
  }

  /** Sesión vigente para un token, o null. Extiende el vencimiento por inactividad (sin pasar el máximo). */
  async resolve(token: string) {
    const s = await this.prisma.platform.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { id: true, isPlatformAdmin: true } } },
    });
    const now = Date.now();
    if (!s || s.revokedAt || s.expiresAt.getTime() <= now) return null;
    if (now - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      // Las sesiones de soporte no se extienden: duran lo que diga el permiso.
      const expiresAt = s.supportGrantId ? s.expiresAt : new Date(Math.min(now + IDLE_MS, s.createdAt.getTime() + ABSOLUTE_MS));
      await this.prisma.platform.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date(now), expiresAt } });
    }
    return s;
  }

  setOrganization(sessionId: string, organizationId: string | null) {
    return this.prisma.platform.session.update({ where: { id: sessionId }, data: { organizationId } });
  }

  revoke(sessionId: string) {
    return this.prisma.platform.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Cierra todas las sesiones de un usuario (opcionalmente menos la actual). */
  revokeAllForUser(userId: string, exceptSessionId?: string) {
    return this.prisma.platform.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
  }
}
