import { Global, Injectable, Logger, Module } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Envío de correo. Por ahora solo registra el mensaje en el log (desarrollo). Para producción se conecta
 * un proveedor (SMTP, SES, Resend…) implementando `deliver`. Mientras tanto la UI entrega el enlace
 * para compartirlo a mano (copiar o WhatsApp).
 */
@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  readonly enabled = false;

  async send(msg: MailMessage): Promise<{ delivered: boolean }> {
    if (process.env.NODE_ENV !== 'test') this.log.log(`(sin proveedor) Para: ${msg.to} · ${msg.subject}`);
    return { delivered: false };
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
