import { readFileSync } from 'node:fs';

const mobileTestCases = JSON.parse(
  readFileSync(new URL('./mobile-test-cases.json', import.meta.url), 'utf-8')
) as {
  testCases: Array<{
    id: string;
    testData: Record<string, unknown>;
  }>;
};

const validLoginUser = {
  mobileNumber: process.env.MOBILE_TEST_USER ?? String(getTestCaseData('TC-002').mobileNumber ?? ''),
  password: process.env.MOBILE_TEST_PASSWORD ?? '',
};

const invalidLoginCases: Record<string, { mobileNumber: string; password: string }> = {
  'TC-003': {
    mobileNumber: String(getTestCaseData('TC-003').mobileNumber ?? '9999999999'),
    password: String(getTestCaseData('TC-003').password ?? validLoginUser.password),
  },
  'TC-004': {
    mobileNumber: String(getTestCaseData('TC-004').mobileNumber ?? validLoginUser.mobileNumber),
    password: String(getTestCaseData('TC-004').password ?? 'wrong-password'),
  },
  'TC-006': {
    mobileNumber: String(getTestCaseData('TC-006').mobileNumber ?? validLoginUser.mobileNumber),
    password: String(getTestCaseData('TC-006').password ?? validLoginUser.password),
  },
  'TC-007': {
    mobileNumber: '',
    password: '',
  },
  'TC-017': {
    mobileNumber: String(getTestCaseData('TC-017').mobileNumber ?? validLoginUser.mobileNumber),
    password: String(getTestCaseData('TC-017').password ?? validLoginUser.password),
  },
  'TC-018': {
    mobileNumber: String(getTestCaseData('TC-018').mobileNumber ?? validLoginUser.mobileNumber),
    password: String(getTestCaseData('TC-018').password ?? validLoginUser.password),
  },
};

function getTestCaseData(testCaseId: string): Record<string, unknown> {
  const match = mobileTestCases.testCases.find((testCase) => testCase.id === testCaseId);
  return match?.testData ?? {};
}

export function getLoginCaseData(testCaseId: string): { mobileNumber: string; password: string } {
  return invalidLoginCases[testCaseId] ?? { ...validLoginUser };
}

export const defaultTestUser = getLoginCaseData('TC-002');

export const defaultStartDayData = {
  odometerReading: process.env.ODOMETER_READING ?? String(getTestCaseData('TC-009').odometerReading ?? '16659'),
};

export const getCaseData = (testCaseId: string, key: string, fallback: string) => {
  const value = getTestCaseData(testCaseId)[key];
  return value === undefined ? fallback : String(value);
};
