import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@mobilewright/test';
import { AppState, ensureAppPreconditionWithRecovery, LoginPage } from '../page-objects/login.page.js';
import { getLoginCaseData } from '../test-data/test-config.js';
import { annotatePriority } from './test-priority.js';

const mobileTestCases = JSON.parse(
  readFileSync(new URL('../test-data/mobile-test-cases.json', import.meta.url), 'utf-8')
) as { testCases: Array<{ id: string; title: string; testData: Record<string, unknown> }> };

const adbPath = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const defaultEmulatorSerial = 'emulator-5554';

const loginTestCases = mobileTestCases.testCases.filter(
  (testCase: { title: string; id: string }) => !testCase.title.toLowerCase().includes('start day')
);

const loginCaseLookup = new Map(loginTestCases.map((entry) => [entry.id, entry]));

function getTestCaseById(id: string) {
  const testCase = loginCaseLookup.get(id);
  if (!testCase) {
    throw new Error(`Missing test case definition for ${id}`);
  }
  return testCase;
}

function getTestDeviceSerial(): string {
  try {
    const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' });
    const onlineDevices = devices
      .split(/\r?\n/)
      .map((line) => line.match(/^(\S+)\s+device(?:\s|$)/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => match[1]);

    return onlineDevices.find((serial) => !serial.startsWith('emulator-')) ?? defaultEmulatorSerial;
  } catch {
    return defaultEmulatorSerial;
  }
}

test.beforeEach(async ({ screen }, testInfo) => {
  annotatePriority(testInfo);
  const loginPage = new LoginPage(screen);

  await loginPage.forceCloseApp();
  await ensureAppPreconditionWithRecovery(screen, AppState.LOGIN_SCREEN, 'Login setup');
});

test.afterEach(async ({ screen }, testInfo) => {
  const loginPage = new LoginPage(screen);

  try {
    await loginPage.dismissExitPromptIfVisible();
  } catch {
    // The next test performs the authoritative state check and cleanup.
  }

  if (testInfo.status === testInfo.expectedStatus) {
    await loginPage.forceCloseApp();
    return;
  }

  try {
    await testInfo.attach('failure-screenshot', {
      body: await screen.screenshot(),
      contentType: 'image/png',
    });
  } catch {
    console.log('Could not capture failure screenshot');
  }

  await loginPage.forceCloseApp();
});

test('TC-002 - Valid SE login succeeds with correct mobile number and password', async ({ screen }) => {
  const loginPage = new LoginPage(screen);
  const tcCase = getTestCaseById('TC-002');

  const loginData = getLoginCaseData('TC-002');
  console.log(`Test data: ${JSON.stringify(tcCase.testData)}`);
  await loginPage.ensureLoggedIn(loginData.mobileNumber, loginData.password);

  const userName = await loginPage.getUserName();
  const postLoginText = await loginPage.expectPostLogin();
  expect(userName.trim().length).toBeGreaterThan(0);
  console.log(`Login successful with user: ${userName}`);
  console.log(`Post-login text: ${postLoginText}`);
});

test('TC-003 - Login attempt with an unregistered mobile number is rejected', async ({ screen }) => {
  const loginPage = new LoginPage(screen);
  const tcCase = getTestCaseById('TC-003');

  const loginData = getLoginCaseData('TC-003');
  console.log(`Test data: ${JSON.stringify(tcCase.testData)}`);
  await loginPage.login(loginData.mobileNumber, loginData.password);
  await loginPage.expectValidationMessage('User not found');
});

test('TC-004 - Login attempt with a valid mobile number but incorrect password is rejected', async ({ screen }) => {
  const loginPage = new LoginPage(screen);
  const tcCase = getTestCaseById('TC-004');

  const loginData = getLoginCaseData('TC-004');
  console.log(`Test data: ${JSON.stringify(tcCase.testData)}`);
  await loginPage.login(loginData.mobileNumber, loginData.password);
  await loginPage.expectValidationMessage('Invalid password');
});

test('TC-006 - Login is blocked with a clear message when the device has no network connectivity', async ({ screen }) => {
  const loginPage = new LoginPage(screen);
  const tcCase = getTestCaseById('TC-006');
  const testDeviceSerial = getTestDeviceSerial();

  console.log(`Test data: ${JSON.stringify(tcCase.testData)}`);
  console.log(`Disabling network on device: ${testDeviceSerial}`);
  execFileSync(adbPath, ['-s', testDeviceSerial, 'shell', 'svc', 'wifi', 'disable']);
  execFileSync(adbPath, ['-s', testDeviceSerial, 'shell', 'svc', 'data', 'disable']);

  try {
    const loginData = getLoginCaseData('TC-006');
    await loginPage.login(loginData.mobileNumber, loginData.password);
    await loginPage.expectValidationMessage('internet connection');
  } finally {
    execFileSync(adbPath, ['-s', testDeviceSerial, 'shell', 'svc', 'wifi', 'enable']);
    execFileSync(adbPath, ['-s', testDeviceSerial, 'shell', 'svc', 'data', 'enable']);
  }
});

test('TC-007 - Login is blocked when mobile number and/or password fields are empty', async ({ screen }) => {
  const loginPage = new LoginPage(screen);
  const tcCase = getTestCaseById('TC-007');

  const loginData = getLoginCaseData('TC-007');
  console.log(`Test data: ${JSON.stringify(tcCase.testData)}`);
  console.log(`Empty form login detection for ${tcCase.id}: mobile=${loginData.mobileNumber}, password=masked`);
  await loginPage.submitEmptyLogin();
  await loginPage.expectValidationMessage('Please enter');
});

test('TC-017 - Mobile Number displays all entered digits in plain text', async ({ screen }) => {
  const loginPage = new LoginPage(screen);
  const tcCase = getTestCaseById('TC-017');

  const loginData = getLoginCaseData('TC-017');
  console.log(`Test data: ${JSON.stringify(tcCase.testData)}`);
  await loginPage.expectLoginScreen();
  await screen.getByPlaceholder('Enter mobile number').fill(loginData.mobileNumber);
  await loginPage.expectMobileNumberReading(loginData.mobileNumber);
});

test('TC-018 - Password is masked by default and toggles to plaintext with Show', async ({ screen }) => {
  const loginPage = new LoginPage(screen);
  const tcCase = getTestCaseById('TC-018');

  console.log(`Test data: ${JSON.stringify(tcCase.testData)}`);
  const loginData = getLoginCaseData('TC-018');
  await loginPage.expectLoginScreen();
  await screen.getByPlaceholder('Enter password').fill(loginData.password);
  await loginPage.expectPasswordMasked(true);
  await loginPage.togglePasswordVisibility();
  await loginPage.expectPasswordMasked(false);
});

test('TC-004-NON-SE - Non-SE role credentials are rejected on the mobile app', async ({ screen }) => {
  const loginPage = new LoginPage(screen);
  await loginPage.login('9999999998', 'test');
  await loginPage.expectValidationMessage('User not found');
});
