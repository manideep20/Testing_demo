import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cleanAllureArtifacts } from './allure-retention.mjs';

test('cleanAllureArtifacts keeps only files created in the last 24 hours', () => {
  const root = join(tmpdir(), `allure-retention-${Date.now()}`);
  const dir = join(root, 'allure-results');
  mkdirSync(dir, { recursive: true });

  const now = new Date('2026-09-17T12:00:00Z');
  const oldFile = join(dir, 'old-result.json');
  const recentFile = join(dir, 'recent-result.json');

  writeFileSync(oldFile, JSON.stringify({ name: 'old' }));
  writeFileSync(recentFile, JSON.stringify({ name: 'recent' }));

  utimesSync(oldFile, new Date('2026-09-15T12:00:00Z'), new Date('2026-09-15T12:00:00Z'));
  utimesSync(recentFile, new Date('2026-09-17T11:30:00Z'), new Date('2026-09-17T11:30:00Z'));

  const result = cleanAllureArtifacts({
    dirs: [dir],
    retentionDays: 1,
    now,
  });

  assert.equal(result.deleted, 1);
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(recentFile), true);

  rmSync(root, { recursive: true, force: true });
});
