import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { smtpOptions } from '../smtp.mjs';

export async function checkSmtp({ env = process.env, transportFactory = nodemailer.createTransport } = {}) {
  let options;
  try {
    if (env.MAIL_TRANSPORT?.toLowerCase().trim() !== 'smtp') throw new Error();
    options = smtpOptions(env);
  } catch { return { configured: false, verified: false, error: 'configuration' }; }
  let transport;
  try {
    transport = transportFactory(options);
    await transport.verify();
    return { configured: true, verified: true };
  } catch (error) {
    const category = error.code === 'EAUTH' ? 'authentication'
      : /certificate|tls|ssl|self.signed/i.test(`${error.code ?? ''} ${error.message ?? ''}`) ? 'tls'
      : 'connection';
    return { configured: true, verified: false, error: category };
  } finally {
    transport?.close?.();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkSmtp();
  console.log(JSON.stringify(result));
  process.exitCode = result.verified ? 0 : 1;
}
