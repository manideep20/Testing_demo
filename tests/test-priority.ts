import type { TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';

type Priority = 'Very High' | 'High' | 'Medium' | 'Low';
type CaseEntry = { id: string; priority?: Priority };

const cases = JSON.parse(
  readFileSync(new URL('../test-data/mobile-test-cases.json', import.meta.url), 'utf-8'),
) as { testCases: CaseEntry[] };

const priorities = new Map(cases.testCases.map((testCase) => [testCase.id, testCase.priority]));

export function annotatePriority(testInfo: TestInfo): void {
  const caseId = testInfo.title.match(/\bTC-\d{3}\b/)?.[0];
  const priority = caseId ? priorities.get(caseId) : undefined;
  if (priority) {
    const severity = {
      'Very High': 'critical',
      High: 'high',
      Medium: 'normal',
      Low: 'minor',
    }[priority];
    testInfo.annotations.push({
      type: 'severity',
      description: severity,
    });
    testInfo.annotations.push({ type: 'priority', description: priority });
  }
}
