import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function cleanAllureArtifacts({
  dirs = ['allure-results', 'allure-report', 'playwright-report'],
  retentionDays = 1,
  now = new Date(),
} = {}) {
  const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (!entry.isFile() && !entry.isDirectory()) continue;

      if (entry.isDirectory()) {
        const nested = cleanAllureArtifacts({
          dirs: [fullPath],
          retentionDays,
          now,
        });
        deleted += nested.deleted;
        continue;
      }

      const stats = statSync(fullPath);
      const ageMs = now.getTime() - stats.mtimeMs;

      if (ageMs > cutoffMs) {
        rmSync(fullPath, { recursive: true, force: true });
        deleted += 1;
      }
    }
  }

  return { deleted };
}
