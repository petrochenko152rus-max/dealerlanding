import nodemailer from 'nodemailer';

function mailbox(value) {
  if (typeof value !== 'string' || /[\r\n\x00]/.test(value)) return null;
  const address = value.match(/<([^<>]+)>\s*$/)?.[1] ?? value.trim();
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(address) ? address : null;
}

// SMTP needs a TCP/TLS connection and direct authentication. HTTP proxy
// placeholders cannot authenticate a mailbox over this protocol.
export function smtpOptions(env) {
  const host = env.SMTP_HOST?.trim() || 'smtp.mail.ru';
  const port = Number(env.SMTP_PORT || 465);
  if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host) || host.length > 253 || ![465, 587].includes(port)) throw new Error('Invalid SMTP host or TLS port.');
  if (!mailbox(env.SMTP_USER) || typeof env.SMTP_PASSWORD !== 'string' || !env.SMTP_PASSWORD.length || !mailbox(env.MAIL_FROM)) throw new Error('Missing SMTP credentials or sender.');
  return {
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user: env.SMTP_USER.trim(), pass: env.SMTP_PASSWORD },
    tls: { servername: host, minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    dnsTimeout: 10_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
}

export function smtpConfigured(env) {
  try { smtpOptions(env); return true; } catch { return false; }
}

export function createSmtpSender(env, transportFactory = nodemailer.createTransport, { delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const options = smtpOptions(env);
  const transport = transportFactory(options);
  const domain = mailbox(env.MAIL_FROM).split('@')[1];
  return async (message, key) => {
    const mail = {
      from: env.MAIL_FROM,
      to: message.to,
      replyTo: message.reply_to,
      subject: message.subject,
      text: message.text,
      messageId: `<${key}@${domain}>`,
      attachments: (message.attachments ?? []).map(file => ({ filename: file.filename, content: Buffer.from(file.content, 'base64'), contentType: file.content_type })),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    let info;
    for (let attempt = 0; ; attempt++) {
      try {
        info = await transport.sendMail(mail);
        break;
      } catch (error) {
        // Retry only an explicit temporary SMTP rejection. An ambiguous
        // disconnect might have happened after acceptance, so do not retry it.
        if (!Number.isInteger(error?.responseCode) || error.responseCode < 400 || error.responseCode >= 500 || attempt >= 2) throw error;
        await delay((attempt + 1) * 1000);
      }
    }
    const accepted = (info?.accepted ?? []).map(item => (typeof item === 'string' ? item : item?.address)?.toLowerCase());
    if ((info?.rejected?.length ?? 0) || !message.to.every(address => accepted.includes(address.toLowerCase()))) throw new Error('SMTP server did not accept every recipient.');
  };
}
