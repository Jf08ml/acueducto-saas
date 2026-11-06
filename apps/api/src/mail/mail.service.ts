import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Responder a (p. ej. el correo de contacto del acueducto). */
  replyTo?: string;
}

export interface MailTransport {
  readonly name: string;
  send(from: string, msg: MailMessage): Promise<void>;
}

/** Desarrollo/pruebas: no envía, solo registra. */
export class LogTransport implements MailTransport {
  readonly name = 'log';
  private readonly log = new Logger('Mail');
  async send(from: string, msg: MailMessage) {
    if (process.env.NODE_ENV !== 'test') this.log.log(`(log) ${from} → ${msg.to} · ${msg.subject}`);
  }
}

/**
 * Amazon SES (API v2). Credenciales por la cadena estándar de AWS (variables AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY, perfil o rol IAM). El remitente debe estar verificado en SES.
 */
export class SesTransport implements MailTransport {
  readonly name = 'ses';
  constructor(
    private readonly client: Pick<SESv2Client, 'send'> = new SESv2Client({ region: process.env.AWS_REGION ?? 'us-east-1' }),
    private readonly configurationSet = process.env.SES_CONFIGURATION_SET,
  ) {}

  async send(from: string, msg: MailMessage) {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [msg.to] },
        ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
        ConfigurationSetName: this.configurationSet,
        Content: {
          Simple: {
            Subject: { Data: msg.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: msg.text, Charset: 'UTF-8' },
              ...(msg.html ? { Html: { Data: msg.html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      }),
    );
  }
}

/** SMTP genérico (cualquier proveedor). Configuración con SMTP_URL o SMTP_HOST/PORT/USER/PASS/SECURE. */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  constructor(private readonly transporter: Transporter = SmtpTransport.fromEnv()) {}

  static fromEnv(): Transporter {
    if (process.env.SMTP_URL) return nodemailer.createTransport(process.env.SMTP_URL);
    if (!process.env.SMTP_HOST) throw new Error('MAIL_PROVIDER=smtp requiere SMTP_URL o SMTP_HOST');
    const port = Number(process.env.SMTP_PORT ?? 587);
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }

  async send(from: string, msg: MailMessage) {
    await this.transporter.sendMail({ from, to: msg.to, replyTo: msg.replyTo, subject: msg.subject, text: msg.text, html: msg.html });
  }
}

export function transportFromEnv(): MailTransport {
  const provider = (process.env.MAIL_PROVIDER ?? 'log').toLowerCase();
  if (provider === 'ses') return new SesTransport();
  if (provider === 'smtp') return new SmtpTransport();
  if (provider !== 'log') throw new Error(`MAIL_PROVIDER desconocido: ${provider} (usa ses, smtp o log)`);
  return new LogTransport();
}

/**
 * Envío de correo con el proveedor de MAIL_PROVIDER. Un fallo del proveedor NUNCA rompe la operación
 * que lo originó (p. ej. crear una invitación): se registra y se informa `delivered: false`, y la UI
 * ofrece el enlace para compartirlo a mano.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  private transport: MailTransport = transportFromEnv();
  private readonly from = process.env.MAIL_FROM ?? 'AguaMata <no-responder@aguamata.local>';

  get provider() {
    return this.transport.name;
  }

  /** Solo para pruebas. */
  useTransport(t: MailTransport) {
    this.transport = t;
  }

  /** @param fromName nombre visible del remitente (p. ej. el acueducto); el correo sigue siendo el de la plataforma. */
  async send(msg: MailMessage, fromName?: string): Promise<{ delivered: boolean; provider: string; error?: string }> {
    if (this.transport.name === 'log') {
      await this.transport.send(this.from, msg);
      return { delivered: false, provider: 'log' };
    }
    const address = /<([^>]+)>/.exec(this.from)?.[1] ?? this.from;
    const from = fromName ? `"${fromName.replace(/["\r\n]/g, '')}" <${address}>` : this.from;
    try {
      await this.transport.send(from, msg);
      return { delivered: true, provider: this.transport.name };
    } catch (e: any) {
      this.log.error(`Falló el envío (${this.transport.name}) a ${msg.to}: ${e?.message ?? e}`);
      return { delivered: false, provider: this.transport.name, error: 'No se pudo enviar el correo' };
    }
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plantilla HTML sencilla y compatible con clientes de correo (tablas, estilos en línea). */
export function emailLayout(opts: { orgName: string; color?: string; title: string; paragraphs: string[]; cta?: { label: string; url: string } }) {
  const color = /^#[0-9a-f]{6}$/i.test(opts.color ?? '') ? opts.color! : '#0b6e99';
  const body = opts.paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.5">${esc(p)}</p>`).join('');
  const cta = opts.cta
    ? `<p style="margin:22px 0"><a href="${esc(opts.cta.url)}" style="background:${color};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;display:inline-block">${esc(opts.cta.label)}</a></p>
       <p style="margin:0;font-size:12px;color:#5d6b78">Si el botón no funciona, copia este enlace: ${esc(opts.cta.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Segoe UI,Arial,sans-serif;color:#15202b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:${color};color:#fff;padding:18px 24px;font-size:18px;font-weight:700">${esc(opts.orgName)}</td></tr>
<tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 16px">${esc(opts.title)}</h1>${body}${cta}</td></tr>
<tr><td style="padding:14px 24px;font-size:12px;color:#5d6b78;border-top:1px solid #e2e7ec">Enviado con AguaMata</td></tr>
</table></td></tr></table></body></html>`;
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
