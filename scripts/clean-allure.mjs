import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { cleanAllureArtifacts } from './allure-retention.mjs';

const isFullReset = process.argv.includes('--full');
const directories = ['allure-results', 'allure-report', 'playwright-report'];

for (const dir of directories) {
  mkdirSync(dir, { recursive: true });
}

if (isFullReset) {
  for (const dir of directories) {
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir)) {
      rmSync(`${dir}/${entry}`, { recursive: true, force: true });
    }
  }

  console.log('Allure and report directories reset for the latest run only.');
  process.exit(0);
}

const result = cleanAllureArtifacts({ dirs: directories, retentionDays: 1 });

console.log(`Allure and report directories cleaned successfully. Removed ${result.deleted} stale artifact(s) older than 1 day.`);
