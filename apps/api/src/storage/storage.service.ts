import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface StorageDriver {
  readonly name: string;
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** Disco local (desarrollo). STORAGE_DIR, por defecto ./storage. */
export class LocalDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root = path.resolve(process.env.STORAGE_DIR ?? 'storage');

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

  async get(key: string) {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
}

/**
 * Amazon S3 o compatible (Cloudflare R2, MinIO, DigitalOcean Spaces) con S3_ENDPOINT.
 * Credenciales por la cadena estándar de AWS. El bucket debe ser PRIVADO: los archivos se sirven
 * siempre a través de la API, que revisa permisos.
 */
export class S3Driver implements StorageDriver {
  readonly name = 's3';
  constructor(
    private readonly bucket = process.env.S3_BUCKET ?? '',
    private readonly client: Pick<S3Client, 'send'> = new S3Client({
      region: process.env.S3_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    }),
  ) {
    if (!bucket) throw new Error('STORAGE_DRIVER=s3 requiere S3_BUCKET');
  }

  async put(key: string, data: Buffer, contentType?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }

  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null;
    } catch (e: any) {
      if (e instanceof NoSuchKey || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function driverFromEnv(): StorageDriver {
  const d = (process.env.STORAGE_DRIVER ?? 'local').toLowerCase();
  if (d === 's3') return new S3Driver();
  if (d !== 'local') throw new Error(`STORAGE_DRIVER desconocido: ${d} (usa local o s3)`);
  return new LocalDriver();
}

/**
 * Archivos por organización (logos, comprobantes, PDF, importaciones). STORAGE_DRIVER=local|s3.
 * Las claves SIEMPRE empiezan por orgs/{organizationId}/ (o platform/) y nunca se construyen con texto del usuario.
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger('Storage');
  private driver: StorageDriver = driverFromEnv();

  get provider() {
    return this.driver.name;
  }

  /** Solo para pruebas. */
  useDriver(d: StorageDriver) {
    this.driver = d;
  }

  orgKey(organizationId: string, ...parts: string[]) {
    if (!/^[0-9a-f-]{36}$/.test(organizationId)) throw new Error('organizationId inválido');
    return ['orgs', organizationId, ...parts].join('/');
  }

  platformKey(...parts: string[]) {
    return ['platform', ...parts].join('/');
  }

  put(key: string, data: Buffer, contentType?: string) {
    return this.driver.put(key, data, contentType);
  }

  get(key: string) {
    return this.driver.get(key);
  }

  async delete(key: string) {
    try {
      await this.driver.delete(key);
    } catch (e: any) {
      this.log.warn(`No se pudo borrar ${key}: ${e?.message ?? e}`);
    }
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
