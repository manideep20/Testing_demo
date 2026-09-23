import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const rootDir = process.cwd();
const resultsDir = join(rootDir, 'allure-results');
const reportDir = join(rootDir, 'allure-report');

mkdirSync(resultsDir, { recursive: true });
mkdirSync(reportDir, { recursive: true });

const environment = {
  'project.name': 'MobileWight_APXMobile',
  framework: 'Mobilewright + Playwright',
  environment: process.env.TEST_ENVIRONMENT ?? 'local',
  'os.platform': process.platform,
  'os.name': os.platform(),
  'os.version': os.release(),
  'node.version': process.version,
  'device.type': process.env.DEVICE_TYPE ?? 'Android',
  'device.id': process.env.DEVICE_ID ?? 'emulator-or-real-device',
  'app.package': process.env.APP_PACKAGE ?? 'com.peakline.sfa',
  'app.name': process.env.APP_NAME ?? 'SFA Android App',
  'app.version': process.env.APP_VERSION ?? 'unknown',
  'automation.execution.date': new Date().toISOString(),
};

const environmentContent = Object.entries(environment)
  .map(([key, value]) => `${key}=${String(value)}`)
  .join('\n');

writeFileSync(join(resultsDir, 'environment.properties'), `${environmentContent}\n`);

const categories = [
  {
    name: 'Product defects',
    matchedStatuses: ['failed'],
    messageRegex: '.*',
    traceRegex: '.*',
  },
  {
    name: 'Test defects',
    matchedStatuses: ['broken'],
    messageRegex: '.*',
    traceRegex: '.*',
  },
  {
    name: 'App crash / unexpected shutdown',
    matchedStatuses: ['broken'],
    messageRegex: '(?i)(crash|app closed|application closed|session closed|unexpected shutdown)',
    traceRegex: '.*',
  },
  {
    name: 'Skipped tests',
    matchedStatuses: ['skipped'],
    messageRegex: '.*',
    traceRegex: '.*',
  },
];

writeFileSync(join(resultsDir, 'categories.json'), `${JSON.stringify(categories, null, 2)}\n`);

const executor = {
  name: 'Mobilewright Automation',
  type: process.env.CI ? 'ci' : 'local',
  url: process.env.CI_SERVER_URL ?? process.env.GITHUB_SERVER_URL ?? 'local',
  buildOrder: Number(process.env.GITHUB_RUN_NUMBER ?? process.env.BUILD_NUMBER ?? 0),
  buildName: process.env.CI_PROJECT_NAME ?? process.env.GITHUB_REPOSITORY ?? 'MobileWight_APXMobile',
  buildUrl: process.env.CI_JOB_URL ?? process.env.GITHUB_RUN_ID ?? '',
  reportName: 'Allure Report',
};

writeFileSync(join(resultsDir, 'executor.json'), `${JSON.stringify(executor, null, 2)}\n`);

const reportWriteSuffix = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join(resultsDir, `run-info-${reportWriteSuffix}.txt`), `Environment prepared at ${new Date().toISOString()}\n`);

console.log(`Allure environment metadata prepared in ${resultsDir}`);
