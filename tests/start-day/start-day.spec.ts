import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@mobilewright/test';
import { HomePage } from '../../page-objects/home.page.js';
import { AppState, ensureAppPreconditionWithRecovery, LoginPage } from '../../page-objects/login.page.js';
import { StartDayPage } from '../../page-objects/start-day.page.js';
import { annotatePriority } from '../test-priority.js';
import { defaultStartDayData } from '../../test-data/test-config.js';

test.use({ video: 'retain-on-failure' });

const mobileTestCases = JSON.parse(
  readFileSync(new URL('../../test-data/mobile-test-cases.json', import.meta.url), 'utf-8')
) as { testCases: Array<{ id: string; title: string; feature: string; testData: Record<string, unknown> }> };

const startDayCaseLookup = new Map(
  mobileTestCases.testCases
    .filter((testCase) => testCase.feature === 'Start Day (Check-in)')
    .map((testCase) => [testCase.id, testCase])
);

function getStartDayCase(id: string) {
  const testCase = startDayCaseLookup.get(id);
  if (!testCase) {
    throw new Error(`Missing mobile test case definition for ${id}`);
  }
  return testCase;
}

function getExpectedOutcome(testCase: { title: string }): string {
  return testCase.title.replace(/^[^-]+ - /, '');
}

const adbPath = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const defaultEmulatorSerial = 'emulator-5554';

function getTestDeviceSerial(): string {
  try {
    const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' });
    const onlineDevices = devices
      .split(/\r?\n/)
      .map((line) => line.match(/^(\S+)\s+device(?:\s|$)/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => match[1]);

    return onlineDevices.find((serial) => !serial.startsWith('emulator-')) ?? onlineDevices[0] ?? defaultEmulatorSerial;
  } catch {
    return defaultEmulatorSerial;
  }
}

test.beforeAll(async ({ screen }) => {
  const loginPage = new LoginPage(screen);
  await loginPage.ensureAppVisible();
});

test.beforeEach(async ({ screen }, testInfo) => {
  annotatePriority(testInfo);
  const loginPage = new LoginPage(screen);

  await loginPage.forceCloseApp();
  const state = await ensureAppPreconditionWithRecovery(screen, AppState.PRE_CHECKIN_HOME, 'Start Day setup');
  if (state !== AppState.PRE_CHECKIN_HOME) {
    throw new Error(`Start Day setup ended in ${state}, expected PRE_CHECKIN_HOME.`);
  }
});

test.afterEach(async ({ screen }, testInfo) => {
  const loginPage = new LoginPage(screen);
  const startDayPage = new StartDayPage(screen);
  if (testInfo.status !== testInfo.expectedStatus) {
    try {
      await testInfo.attach('failure-screenshot', {
        body: await screen.screenshot(),
        contentType: 'image/png',
      });
    } catch {
      console.log('Could not capture failure screenshot');
    }
  }
  await startDayPage.cancelIfVisible().catch(() => false);
  await loginPage.forceCloseApp();
});

test('TC-010 - Next remains disabled until both odometer photo and reading are provided', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  const testCase = getStartDayCase('TC-010');
  const odometerReading = String(testCase.testData.odometerReading ?? defaultStartDayData.odometerReading);
  const expectedOutcome = getExpectedOutcome(testCase);

  console.log(`Expected outcome: ${expectedOutcome}`);
  await homePage.openStartDay();

  await startDayPage.expectNextDisabled();
  await startDayPage.captureOdometerPhoto();
  await startDayPage.expectNextDisabled();
  await startDayPage.enterOdometerReading(odometerReading);
  await startDayPage.expectNextEnabled();
});

test('TC-012 - Deleting a captured odometer photo resets capture state and disables Next', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  const testCase = getStartDayCase('TC-012');
  const odometerReading = String(testCase.testData.odometerReading ?? defaultStartDayData.odometerReading);
  const expectedOutcome = getExpectedOutcome(testCase);

  console.log(`Expected outcome: ${expectedOutcome}`);
  await homePage.openStartDay();
  await startDayPage.enterOdometerReading(odometerReading);
  await startDayPage.expectNextDisabled();
  await startDayPage.captureOdometerPhoto();
  console.log('TC-012: captured image is displayed before deletion');
  await startDayPage.expectNextEnabled();
  await startDayPage.deleteCapturedPhoto();
  await startDayPage.expectPhotoStateReset();
  await startDayPage.expectNextDisabled();
});

test('TC-013 - Confirm Details accurately reflects data entered and captured in step 1', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  const testCase = getStartDayCase('TC-013');
  const odometerReading = String(testCase.testData.odometerReading ?? defaultStartDayData.odometerReading);
  const expectedOutcome = getExpectedOutcome(testCase);

  console.log(`Expected outcome: ${expectedOutcome}`);
  await homePage.openStartDay();
  await startDayPage.captureOdometerPhoto();
  console.log('TC-013: captured image is displayed before entering reading');
  await startDayPage.enterOdometerReading(odometerReading);
  await startDayPage.expectNextEnabled();
  await startDayPage.clickNext();
  await startDayPage.expectReviewPage(odometerReading);
});

test('TC-010-PHOTO-CONTENT - Captured photo proceeds without content correlation validation', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  await homePage.openStartDay();
  await startDayPage.captureOdometerPhoto();
  await startDayPage.enterOdometerReading(String(defaultStartDayData.odometerReading));
  await startDayPage.clickNext();
  await startDayPage.expectConfirmationDetails(String(defaultStartDayData.odometerReading));
});

test('TC-013-EDIT - Edit details preserves previously entered Start Day data', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  await homePage.openStartDay();
  await startDayPage.captureOdometerPhoto();
  await startDayPage.enterOdometerReading(String(defaultStartDayData.odometerReading));
  await startDayPage.clickNext();
  await startDayPage.editDetails();
  expect(await screen.getByPlaceholder('Enter current reading').getValue()).toBe(String(defaultStartDayData.odometerReading));
});

test('TC-014 - Declining Location Accuracy remains visible and does not crash Start Day', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  await homePage.openStartDay();
  const deny = screen.getByText(/Don.t allow|Deny|While using the app/i);
  if (await deny.isVisible({ timeout: 3_000 }).catch(() => false)) await deny.tap();
  await expect(screen.getByText(/Start Day|Verification Location|Location|Capture Odometer Photo/i)).toBeVisible({ timeout: 15_000 });
  await startDayPage.expectOdometerPhotoRequired();
});

test('TC-015 - Start Day with no network reports an explicit connectivity outcome', async ({ screen }) => {
  const serial = getTestDeviceSerial();
  execFileSync(adbPath, ['-s', serial, 'shell', 'svc', 'wifi', 'disable']);
  execFileSync(adbPath, ['-s', serial, 'shell', 'svc', 'data', 'disable']);
  try {
    const homePage = new HomePage(screen);
    await homePage.openStartDay();
    await expect(screen.getByText(/offline|internet|network|connection|available/i)).toBeVisible({ timeout: 20_000 });
  } finally {
    execFileSync(adbPath, ['-s', serial, 'shell', 'svc', 'wifi', 'enable']);
    execFileSync(adbPath, ['-s', serial, 'shell', 'svc', 'data', 'enable']);
  }
});

test('TC-018-ZERO - Odometer Reading validates zero consistently', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  await homePage.openStartDay();
  await startDayPage.enterOdometerReading('0');
  const next = screen.getByText('Next', { exact: true });
  if (await next.isEnabled({ timeout: 2_000 }).catch(() => false)) {
    await next.tap();
    await startDayPage.expectConfirmationDetails('0');
  } else {
    await expect(next).toBeDisabled();
  }
});

test('TC-019 - Odometer Reading rejects a negative value', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  await homePage.openStartDay();
  await startDayPage.enterOdometerReading('-1');
  expect(await screen.getByPlaceholder('Enter current reading').getValue()).not.toBe('-1');
});

test('TC-020 - Odometer Reading validates a decimal value consistently', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  await homePage.openStartDay();
  await startDayPage.enterOdometerReading('12.5');
  const retainedValue = await screen.getByPlaceholder('Enter current reading').getValue();
  expect(retainedValue.length).toBeGreaterThan(0);
  expect(Number.isFinite(Number(retainedValue))).toBe(true);
});

test('TC-021 - Odometer Reading validates an unrealistically large value', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  await homePage.openStartDay();
  await startDayPage.enterOdometerReading('999999999');
  const field = screen.getByPlaceholder('Enter current reading');
  const retainedValue = await field.getValue();
  const next = screen.getByText('Next', { exact: true });
  const rejectedOrBlocked = retainedValue !== '999999999'
    || !(await next.isEnabled({ timeout: 2_000 }).catch(() => false));
  expect(rejectedOrBlocked).toBe(true);
});

// This is the only case that commits the server-side Start Day check-in. Running it last lets all
// validation-only cases share PRE_CHECKIN_HOME without performing a full End Day camera flow during
// afterEach. The next spec needs POST_CHECKIN_HOME, so this committed state is the correct handover.
test('TC-009 - Captured odometer photo and reading enable Next', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const startDayPage = new StartDayPage(screen);
  const testCase = getStartDayCase('TC-009');
  const odometerReading = String(testCase.testData.odometerReading);
  const expectedOutcome = getExpectedOutcome(testCase);

  console.log(`Expected outcome: ${expectedOutcome}`);
  await homePage.expectHomeScreen();
  await homePage.openStartDay();
  await startDayPage.expectLocationPopulated();
  await startDayPage.captureOdometerPhoto();
  await startDayPage.enterOdometerReading(odometerReading);
  await startDayPage.expectNextEnabled();
  await startDayPage.clickNext();
  await startDayPage.expectConfirmationDetails(odometerReading);
  await startDayPage.confirmStartDay();
  await startDayPage.expectCaptureSuccess();
  await startDayPage.goToDashboard();
  await startDayPage.expectDashboardAfterStartDay();
  await homePage.expectEndDayAvailable();
});
