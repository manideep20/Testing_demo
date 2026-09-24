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
  mobileNumber: process.env.MOBILE_TEST_USER ?? String(getTestCaseData('TC-002').mobileNumber ?? '1000000009'),
  password: process.env.MOBILE_TEST_PASSWORD ?? String(getTestCaseData('TC-002').password ?? 'test'),
};

// Every case that needs a real, registered account reuses `validLoginUser` so the whole suite runs
// as a single SE. Only the cases whose purpose is to reject an account may use a different number.
const unregisteredLoginUser = {
  mobileNumber: String(getTestCaseData('TC-003').mobileNumber ?? '9999999999'),
  password: String(getTestCaseData('TC-003').password ?? validLoginUser.password),
};

export const nonSeLoginUser = {
  mobileNumber: String(getTestCaseData('TC-004-NON-SE').mobileNumber ?? '9999999998'),
  password: String(getTestCaseData('TC-004-NON-SE').password ?? validLoginUser.password),
};

const loginCaseOverrides: Record<string, { mobileNumber: string; password: string }> = {
  'TC-003': unregisteredLoginUser,
  'TC-004': {
    mobileNumber: validLoginUser.mobileNumber,
    password: String(getTestCaseData('TC-004').password ?? 'wrong-password'),
  },
  'TC-006': { ...validLoginUser },
  'TC-007': {
    mobileNumber: '',
    password: '',
  },
  'TC-017': { ...validLoginUser },
  'TC-018': { ...validLoginUser },
  'TC-004-NON-SE': nonSeLoginUser,
};

function getTestCaseData(testCaseId: string): Record<string, unknown> {
  const match = mobileTestCases.testCases.find((testCase) => testCase.id === testCaseId);
  return match?.testData ?? {};
}

export function getLoginCaseData(testCaseId: string): { mobileNumber: string; password: string } {
  return loginCaseOverrides[testCaseId] ?? { ...validLoginUser };
}

export const defaultTestUser = { ...validLoginUser };

export const defaultStartDayData = {
  odometerReading: process.env.ODOMETER_READING ?? String(getTestCaseData('TC-009').odometerReading ?? '16659'),
};

export const getCaseData = (testCaseId: string, key: string, fallback: string) => {
  const value = getTestCaseData(testCaseId)[key];
  return value === undefined ? fallback : String(value);
};
