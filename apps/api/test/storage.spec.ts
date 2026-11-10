import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { LocalDriver, S3Driver, StorageService } from '../src/storage/storage.service';

describe('Almacenamiento', () => {
  it('local: guarda, lee, borra y no permite salirse de la carpeta', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-storage-'));
    process.env.STORAGE_DIR = dir;
    const d = new LocalDriver();
    await d.put('orgs/x/a.txt', Buffer.from('hola'));
    expect((await d.get('orgs/x/a.txt'))?.toString()).toBe('hola');
    await d.delete('orgs/x/a.txt');
    expect(await d.get('orgs/x/a.txt')).toBeNull();
    await expect(d.put('../fuera.txt', Buffer.from('x'))).rejects.toThrow('fuera');
    rmSync(dir, { recursive: true, force: true });
    delete process.env.STORAGE_DIR;
  });

  it('S3: bucket privado con cifrado y 404 como null', async () => {
    const sent: any[] = [];
    const objects = new Map<string, Buffer>();
    const client = {
      send: async (cmd: any) => {
        sent.push(cmd);
        if (cmd instanceof PutObjectCommand) { objects.set(cmd.input.Key!, cmd.input.Body as Buffer); return {}; }
        if (cmd instanceof GetObjectCommand) {
          const b = objects.get(cmd.input.Key!);
          if (!b) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
          return { Body: { transformToByteArray: async () => new Uint8Array(b) } };
        }
        return {};
      },
    };
    const d = new S3Driver('mi-bucket', client as any);
    await d.put('orgs/x/logo.png', Buffer.from('png'), 'image/png');
    expect(sent[0].input).toMatchObject({ Bucket: 'mi-bucket', Key: 'orgs/x/logo.png', ContentType: 'image/png', ServerSideEncryption: 'AES256' });
    expect((await d.get('orgs/x/logo.png'))?.toString()).toBe('png');
    expect(await d.get('orgs/x/no-existe.png')).toBeNull();
  });

  it('S3 sin bucket no arranca', () => {
    expect(() => new S3Driver('', { send: async () => ({}) } as any)).toThrow('S3_BUCKET');
  });

  it('las claves de organización exigen un id válido', () => {
    const s = new StorageService();
    expect(s.orgKey('1b6a1d2e-5c0e-4d3f-9a7b-0c1d2e3f4a5b', 'branding', 'logo.png')).toBe('orgs/1b6a1d2e-5c0e-4d3f-9a7b-0c1d2e3f4a5b/branding/logo.png');
    expect(() => s.orgKey('../otro', 'x')).toThrow();
  });
});
