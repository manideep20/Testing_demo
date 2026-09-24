import { expect, test } from '@mobilewright/test';
import { readFileSync } from 'node:fs';
import { EndDayPage } from '../../page-objects/end-day.page.js';
import { annotatePriority } from '../test-priority.js';
import { HomePage } from '../../page-objects/home.page.js';
import { AppState, ensureAppPreconditionWithRecovery, LoginPage } from '../../page-objects/login.page.js';
import { defaultStartDayData, defaultTestUser } from '../../test-data/test-config.js';

const mobileTestCases = JSON.parse(
  readFileSync(new URL('../../test-data/mobile-test-cases.json', import.meta.url), 'utf-8')
) as { testCases: Array<{ id: string; testData: Record<string, unknown> }> };

function getCaseData(id: string): Record<string, unknown> {
  const testCase = mobileTestCases.testCases.find((entry) => entry.id === id);
  if (!testCase) throw new Error(`Missing mobile test case definition for ${id}`);
  return testCase.testData;
}

test.beforeAll(async ({ screen }) => {
  test.setTimeout(10 * 60 * 1000);
  const loginPage = new LoginPage(screen);
  await loginPage.ensureAppVisible();
  await loginPage.dismissExitPromptIfVisible();
  // ensureLoggedIn is idempotent (skips the logout/login cycle if the configured user is already the
  // active session), so this always applies the configured test user (see test-data/test-config.ts)
  // instead of silently reusing whatever session happened to be left on the device from a prior file.
  await loginPage.ensureLoggedIn(defaultTestUser.mobileNumber, defaultTestUser.password);
});

test.beforeEach(async ({ screen }, testInfo) => {
  annotatePriority(testInfo);
  const expectedState = testInfo.title.startsWith('TC-051')
    ? AppState.DAY_COMPLETED
    : AppState.POST_CHECKIN_HOME;
  const state = await ensureAppPreconditionWithRecovery(screen, expectedState, 'End Day setup');
  if (state !== expectedState) {
    throw new Error(`End Day setup ended in ${state}, expected ${expectedState}.`);
  }
});

test.afterEach(async ({ screen }, testInfo) => {
  const loginPage = new LoginPage(screen);
  if (testInfo.status !== testInfo.expectedStatus) {
    try {
      await testInfo.attach('failure-screenshot', {
        body: await screen.screenshot(),
        contentType: 'image/png',
      });
    } catch {
      console.log('Could not capture End Day failure screenshot');
    }
  }

  if (testInfo.status !== testInfo.expectedStatus) {
    await loginPage.forceCloseApp().catch((error) => {
      console.log(`End Day app cleanup (force-close) failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
});

test('TC-049 - End Day rejects a reading below the Start Day reading', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const endDayPage = new EndDayPage(screen);
  const initialReading = String(getCaseData('TC-049').odometerReading);

  await homePage.openEndDay();
  await endDayPage.captureOdometerPhoto();
  await endDayPage.enterOdometerReading(initialReading);
  await endDayPage.clickNext();
  await expect(screen.getByText(/End odometer reading must be greater than start odometer reading/i)).toBeVisible({
    timeout: 15_000,
  });
  await endDayPage.dismissValidationDialog();
  const validReading = await endDayPage.enterUntilConfirmation(initialReading);
  await endDayPage.expectConfirmationDetails(validReading);
});

test('TC-050 - End Day remark is preserved through Confirm Details', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const endDayPage = new EndDayPage(screen);
  const testData = getCaseData('TC-050');
  const remark = String(testData.remark);
  const initialReading = String(getCaseData('TC-048').odometerReading);

  await homePage.openEndDay();
  await endDayPage.captureOdometerPhoto();
  const reading = String(Math.max(Number(initialReading), Number(defaultStartDayData.odometerReading) + 1));
  await endDayPage.enterOdometerReading(reading);
  await endDayPage.clickNext();
  await endDayPage.expectConfirmationDetails(reading);
  const entered = await endDayPage.enterRemark(remark);
  expect(entered).toBe(true);
  await endDayPage.expectRemark(remark);
});

// This is the only case that commits End Day. Keep it after validation-only cases so the selected
// user remains checked in while TC-049 and TC-050 exercise the form.
test('TC-048 - Complete End Day check-out flow successfully', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const endDayPage = new EndDayPage(screen);
  const initialReading = String(getCaseData('TC-048').odometerReading);

  await homePage.openEndDay();
  await endDayPage.expectEndDayScreen();
  await endDayPage.captureOdometerPhoto();
  const reading = await endDayPage.enterUntilConfirmation(initialReading);
  await endDayPage.expectConfirmationDetails(reading);
  await endDayPage.confirmEndDay();
  await endDayPage.expectEndDaySuccess();
  await endDayPage.goToDashboard();
});

test('TC-051 - Day Completed summary is displayed after End Day', async ({ screen }) => {
  const homePage = new HomePage(screen);
  const endDayPage = new EndDayPage(screen);

  await expect(screen.getByText(/Day Completed|Start odometer|End odometer|Outlets Visited|Active Duration/i)).toBeVisible({
    timeout: 15_000,
  });
  await endDayPage.backToHome();
  await homePage.expectHomeScreen();
});
