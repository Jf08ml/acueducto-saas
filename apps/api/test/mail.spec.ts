/**
 * Transportes de correo, sin red: SES con un cliente simulado y SMTP con el transporte JSON de nodemailer.
 */
import nodemailer from 'nodemailer';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { emailLayout, MailService, SesTransport, SmtpTransport, transportFromEnv } from '../src/mail/mail.service';

const msg = { to: 'ana@correo.co', subject: 'Invitación', text: 'Hola', html: '<p>Hola</p>', replyTo: 'contacto@acueducto.org' };

describe('Correo', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('elige el proveedor según MAIL_PROVIDER', () => {
    process.env.MAIL_PROVIDER = 'log';
    expect(transportFromEnv().name).toBe('log');
    process.env.MAIL_PROVIDER = 'ses';
    expect(transportFromEnv().name).toBe('ses');
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_URL = 'smtp://usuario:clave@smtp.ejemplo.co:587';
    expect(transportFromEnv().name).toBe('smtp');
    process.env.MAIL_PROVIDER = 'sendgrid';
    expect(() => transportFromEnv()).toThrow(/desconocido/);
  });

  it('SMTP sin host configurado falla al arrancar, no al enviar', () => {
    process.env.MAIL_PROVIDER = 'smtp';
    delete process.env.SMTP_URL;
    delete process.env.SMTP_HOST;
    expect(() => transportFromEnv()).toThrow(/SMTP_URL o SMTP_HOST/);
  });

  it('SES arma el SendEmailCommand con texto, HTML, respuesta y conjunto de configuración', async () => {
    const sent: any[] = [];
    const t = new SesTransport({ send: async (cmd: any) => { sent.push(cmd); return {} as any; } } as any, 'aguamata-envios');
    await t.send('"Acueducto X" <no-responder@aguamata.co>', msg);
    expect(sent[0]).toBeInstanceOf(SendEmailCommand);
    expect(sent[0].input).toMatchObject({
      FromEmailAddress: '"Acueducto X" <no-responder@aguamata.co>',
      Destination: { ToAddresses: ['ana@correo.co'] },
      ReplyToAddresses: ['contacto@acueducto.org'],
      ConfigurationSetName: 'aguamata-envios',
      Content: { Simple: { Subject: { Data: 'Invitación' }, Body: { Text: { Data: 'Hola' }, Html: { Data: '<p>Hola</p>' } } } },
    });
  });

  it('SMTP envía el mensaje completo', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const spy = jest.spyOn(transporter, 'sendMail');
    await new SmtpTransport(transporter).send('AguaMata <no-responder@aguamata.co>', msg);
    expect(spy.mock.calls[0][0]).toMatchObject({ to: 'ana@correo.co', replyTo: 'contacto@acueducto.org', subject: 'Invitación', html: '<p>Hola</p>' });
  });

  it('usa el nombre del acueducto como remitente visible y no rompe si el proveedor falla', async () => {
    process.env.MAIL_FROM = 'AguaMata <no-responder@aguamata.co>';
    const svc = new MailService();
    const froms: string[] = [];
    svc.useTransport({ name: 'ses', send: async (from) => { froms.push(from); } });
    expect(await svc.send(msg, 'Acueducto "El Encano"')).toEqual({ delivered: true, provider: 'ses' });
    expect(froms[0]).toBe('"Acueducto El Encano" <no-responder@aguamata.co>');

    svc.useTransport({ name: 'smtp', send: async () => { throw new Error('535 auth failed'); } });
    expect(await svc.send(msg)).toEqual({ delivered: false, provider: 'smtp', error: 'No se pudo enviar el correo' });
  });

  it('la plantilla escapa el contenido', () => {
    const html = emailLayout({ orgName: '<script>x</script>', title: 'T', paragraphs: ['a & b'], cta: { label: 'Ir', url: 'https://x.co/?a=1&b=2' } });
    expect(html).not.toContain('<script>');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('https://x.co/?a=1&amp;b=2');
  });
});
