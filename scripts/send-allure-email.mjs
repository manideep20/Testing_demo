import { createWriteStream } from 'node:fs';
import { existsSync, createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import nodemailer from 'nodemailer';

const require = createRequire(import.meta.url);
const archiver = require('archiver');

const reportDirectory = resolve('allure-report');
const archivePath = resolve('allure-report.zip');

const requiredEnvironment = ['ALLURE_EMAIL_TO', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);

if (missingEnvironment.length > 0) {
  throw new Error(
    `Allure report was generated, but email was not sent. Configure: ${missingEnvironment.join(', ')}. ` +
      'See .env.example for the required settings.',
  );
}

if (!existsSync(reportDirectory)) {
  throw new Error(`Allure report directory does not exist: ${reportDirectory}`);
}

await new Promise((resolvePromise, rejectPromise) => {
  const output = createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', resolvePromise);
  output.on('error', rejectPromise);
  archive.on('error', rejectPromise);
  archive.pipe(output);
  archive.directory(reportDirectory, 'allure-report');
  archive.finalize();
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

const recipients = process.env.ALLURE_EMAIL_TO.split(',')
  .map((address) => address.trim())
  .filter(Boolean);

await transporter.sendMail({
  from: process.env.ALLURE_EMAIL_FROM ?? process.env.SMTP_USER,
  to: recipients,
  subject: process.env.ALLURE_EMAIL_SUBJECT ?? 'Mobilewright Allure test report',
  text: 'The Mobilewright test run has completed. The generated Allure report is attached.',
  attachments: [
    {
      filename: 'allure-report.zip',
      content: createReadStream(archivePath),
    },
  ],
});

console.log(`Allure report emailed to ${recipients.join(', ')}`);
