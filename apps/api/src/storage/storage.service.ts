import { Global, Injectable, Module } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Almacenamiento de archivos por organización. Implementación local para desarrollo;
 * en producción se reemplaza por S3/compatible con la misma interfaz.
 * Las claves SIEMPRE empiezan por orgs/{organizationId}/ y nunca se construyen con texto del usuario.
 */
@Injectable()
export class StorageService {
  private readonly root = path.resolve(process.env.STORAGE_DIR ?? 'storage');

  orgKey(organizationId: string, ...parts: string[]) {
    if (!/^[0-9a-f-]{36}$/.test(organizationId)) throw new Error('organizationId inválido');
    return ['orgs', organizationId, ...parts].join('/');
  }

  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Clave fuera del almacenamiento');
    return full;
  }

  async put(key: string, data: Buffer) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
