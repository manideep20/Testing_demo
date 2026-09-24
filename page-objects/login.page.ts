import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { expect } from '@mobilewright/test';
import type { Screen } from '@mobilewright/core';
import { defaultStartDayData, defaultTestUser } from '../test-data/test-config.js';
import { EndDayPage } from './end-day.page.js';
import { HomePage } from './home.page.js';
import { StartDayPage } from './start-day.page.js';

const adbPath = resolve(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');

// Tracks which mobile number is currently authenticated in the app for this test run (single worker),
// so ensureLoggedIn can skip an unnecessary logout/login cycle when the correct user is already active.
let currentLoggedInMobileNumber: string | undefined;

function getSeNameForMobileNumber(mobileNumber: string): string | undefined {
  return mobileNumber === defaultTestUser.mobileNumber
    ? process.env.MOBILE_TEST_USER_NAME
    : undefined;
}

// Standalone (not tied to LoginPage) so any page object can dismiss the "Exit App" confirmation that
// Android's BACK gesture/press triggers from a root screen (e.g. Home, or the outlet list). Includes an
// ADB-dump fallback for when the overlay's accessible text isn't reliably matched by the driver.
export async function dismissExitPromptIfVisible(screen: Screen): Promise<boolean> {
  const exitPrompt = screen.getByText(/Exit App|Exit app|Are you sure you want to exit the app/i);
  if (!(await exitPrompt.isVisible({ timeout: 300 }).catch(() => false))) {
    return false;
  }

  const cancelButtons = [
    screen.getByText('CANCEL', { exact: true }),
    screen.getByText('Cancel', { exact: true }),
    screen.getByText('No', { exact: true }),
    screen.getByRole('button', { name: /cancel|no/i }),
  ];

  for (const cancel of cancelButtons) {
    if (await cancel.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log('Exit App prompt detected; tapping cancel');
      // isVisible() above can report true from a stale/cached read while the dialog is already
      // animating away (or has been dismissed by a prior iteration); a hanging tap() then burns a
      // full 10s actionability wait before throwing and crashing whatever recovery loop called this.
      // Treat a failed tap as "the prompt is already gone" instead of propagating the error.
      const tapped = await cancel.tap().then(() => true).catch(() => false);
      if (tapped) return true;
      break;
    }
  }

  const serial = getDeviceSerial();
  try {
    execAdb(['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/exit-confirmation.xml'], { stdio: 'ignore' });
    const dump = execAdb(['-s', serial, 'shell', 'cat', '/sdcard/exit-confirmation.xml'], { encoding: 'utf8' });
    if (/Exit App|Are you sure you want to exit the app/i.test(dump)) {
      const cancelNode = dump.match(/<node\b[^>]*(?:text|content-desc)="(?:CANCEL|Cancel|NO|No)"[^>]*>/i)?.[0];
      const bounds = cancelNode?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (bounds) {
        const x = Math.round((Number(bounds[1]) + Number(bounds[3])) / 2);
        const y = Math.round((Number(bounds[2]) + Number(bounds[4])) / 2);
        execAdb(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], { stdio: 'ignore' });
        await new Promise((resolve) => setTimeout(resolve, 500));
        console.log('Exit App prompt detected via ADB fallback; tapped the cancel control');
        return true;
      }
    }
  } catch {
    // The modal may have already disappeared; treat the prompt as handled.
  }

  return true;
}

// The app's own bottom-nav "Home" tab and the Android OS's system navigation "Home" button both expose
// an accessible label/text of exactly "Home", so an ambiguous getByLabel('Home')/getByText('Home') can
// resolve to and tap the OS button instead — backgrounding the entire app to the launcher. This was the
// root cause of the app repeatedly "closing" during automated recovery. Scan the raw view tree instead
// and only tap a node whose identifier does NOT belong to a system-owned package (systemui, launcher).
export async function tapAppHomeTab(screen: Screen): Promise<boolean> {
  // Read-only scan to identify the app's own bottom-nav "Home" tab (excluding any system-UI/launcher
  // node also labeled "Home"), then tap it via the Locator API so no raw coordinate is ever supplied
  // by this code -- the Locator resolves its own live bounds at tap time.
  const nodes = await screen.viewTree();
  type Node = (typeof nodes)[number];
  let target: Node | undefined;
  const isSystemOwned = (node: Node): boolean => {
    const identifier = (node as unknown as { identifier?: string; resourceId?: string }).identifier
      ?? (node as unknown as { resourceId?: string }).resourceId
      ?? '';
    return /^(?:com\.android\.systemui|com\.sec\.android\.app\.launcher|com\.google\.android\.apps\.nexuslauncher)/i.test(identifier);
  };
  const walk = (node: Node): void => {
    if (target) return;
    const value = (node.text ?? node.label ?? '').trim();
    if (node.isVisible && value === 'Home' && !isSystemOwned(node)) {
      target = node;
      return;
    }
    for (const child of node.children) walk(child);
  };
  for (const root of nodes) walk(root);
  if (!target) {
    return false;
  }

  const targetCenterX = target.bounds.x + target.bounds.width / 2;
  const targetCenterY = target.bounds.y + target.bounds.height / 2;
  const candidates = await screen.getByText('Home', { exact: true }).all();
  let best: { locator: (typeof candidates)[number]; distance: number } | undefined;
  for (const candidate of candidates) {
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;
    const candidateCenterX = box.x + box.width / 2;
    const candidateCenterY = box.y + box.height / 2;
    const distance = Math.hypot(candidateCenterX - targetCenterX, candidateCenterY - targetCenterY);
    if (!best || distance < best.distance) {
      best = { locator: candidate, distance };
    }
  }
  if (!best) {
    return false;
  }
  await best.locator.tap();
  return true;
}

export const AppState = {
  LOGIN_SCREEN: 'LOGIN_SCREEN',
  PRE_CHECKIN_HOME: 'PRE_CHECKIN_HOME',
  POST_CHECKIN_HOME: 'POST_CHECKIN_HOME',
  CHECKOUT_SCREEN: 'CHECKOUT_SCREEN',
  DAY_COMPLETED: 'DAY_COMPLETED',
  UNKNOWN: 'UNKNOWN',
  APP_CLOSED: 'APP_CLOSED',
} as const;

export type AppStateValue = (typeof AppState)[keyof typeof AppState];

export async function detectAppState(screen: Screen): Promise<AppStateValue> {
  try {
    const serial = getDeviceSerial();
    const activityDump = execAdb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' });
    const appClosed = !/com\.peakline\.sfa/i.test(activityDump) || /topResumedActivity=.*com\.sec\.android\.app\.launcher/i.test(activityDump);
    if (appClosed) {
      return AppState.APP_CLOSED;
    }
  } catch {
    // A temporary ADB failure should fall back to the visible UI state instead of forcing a false negative.
  }

  const uiChecks: Array<{ state: AppStateValue; locators: Array<ReturnType<Screen['getByText']> | ReturnType<Screen['getByPlaceholder']> | ReturnType<Screen['getByLabel']>> }> = [
    {
      state: AppState.POST_CHECKIN_HOME,
      locators: [
        screen.getByText('Check out for the day', { exact: true }),
        screen.getByText("Today's route", { exact: true }),
        screen.getByLabel('Check out for the day'),
      ],
    },
    {
      state: AppState.PRE_CHECKIN_HOME,
      locators: [
        screen.getByText('Check in for the day', { exact: true }),
        screen.getByText('Mark attendance', { exact: true }),
        screen.getByLabel('Check in for the day'),
      ],
    },
    {
      state: AppState.LOGIN_SCREEN,
      locators: [screen.getByPlaceholder('Enter mobile number'), screen.getByPlaceholder('Enter password'), screen.getByText('Log in')],
    },
    {
      state: AppState.DAY_COMPLETED,
      locators: [screen.getByText(/Day Completed|Day completed/i), screen.getByText(/Go to dashboard|Back to Home/i)],
    },
    {
      state: AppState.CHECKOUT_SCREEN,
      locators: [
        screen.getByText(/End Day|Enter current reading|Capture Odometer Photo|Confirm details|Review/i),
        screen.getByText(/Confirm\s*(?:&|and)\s*End\s*Day/i),
      ],
    },
  ];

  for (const check of uiChecks) {
    for (const locator of check.locators) {
      if (await locator.isVisible({ timeout: 400 }).catch(() => false)) {
        return check.state;
      }
    }
  }

  return AppState.UNKNOWN;
}

export async function forceCloseApp(): Promise<void> {
  const serial = getDeviceSerial();
  for (const packageName of ['com.peakline.sfa']) {
    execAdb(['-s', serial, 'shell', 'am', 'force-stop', packageName], { stdio: 'ignore' });
    const activities = execAdb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], {
      encoding: 'utf8',
    });
    if (new RegExp(`topResumedActivity=.*${packageName.replace('.', '\\.')}/`, 'i').test(activities)) {
      throw new Error(`Unable to force-close application package ${packageName}.`);
    }
  }
}

// A plain force-stop leaves the app's local data (session token, cached UI state) intact, which is
// normally desirable (it's what makes the fast handover between tests possible). But when the app is
// left in a genuinely broken state (e.g. a stuck/half-submitted screen after a failed tap, or an ANR)
// a force-stop + relaunch alone can come back to that same broken state. This clears all app data too
// (force-stop, pm clear, re-grant the permissions the app needs) so the very next launch is guaranteed
// to be a truly clean slate, like a real user reinstalling the app -- used only as an escalation
// fallback, not on every routine test handover.
export async function forceCloseAndClearAppData(): Promise<void> {
  const serial = getDeviceSerial();
  await forceCloseApp();
  execAdb(['-s', serial, 'shell', 'pm', 'clear', 'com.peakline.sfa'], { stdio: 'ignore' });
  currentLoggedInMobileNumber = undefined;
}

export async function ensureAppPrecondition(screen: Screen, requiredAppState: AppStateValue): Promise<AppStateValue> {
  const loginPage = new LoginPage(screen);
  const homePage = new HomePage(screen);
  let currentState = await detectAppState(screen);

  if (currentState === AppState.APP_CLOSED || currentState === AppState.UNKNOWN) {
    await loginPage.ensureAppVisible();
    currentState = await detectAppState(screen);
  }

  // A screen already sitting in a logged-in state (e.g. left over from a previous test/session)
  // doesn't guarantee it belongs to the currently configured test user -- switching
  // MOBILE_TEST_USER/defaultTestUser should still force a logout+relogin instead of silently
  // reusing whichever session happens to already be active. This must run before both the
  // early-return below AND the switch-case below, since either path can otherwise reuse a
  // stale/mismatched session without ever checking identity.
  const loggedInStates: AppStateValue[] = [
    AppState.PRE_CHECKIN_HOME,
    AppState.POST_CHECKIN_HOME,
    AppState.CHECKOUT_SCREEN,
    AppState.DAY_COMPLETED,
  ];
  if (
    loggedInStates.includes(currentState)
    && currentLoggedInMobileNumber !== defaultTestUser.mobileNumber
  ) {
    const expectedName = getSeNameForMobileNumber(defaultTestUser.mobileNumber);
    const activeName = await loginPage.getActiveSeName();
    if (expectedName && activeName && expectedName !== activeName) {
      console.log(
        `Precondition check: active session belongs to ${activeName}, but the configured test user `
        + `is ${expectedName} (${defaultTestUser.mobileNumber}); switching users.`,
      );
      await loginPage.ensureLoggedOut();
      currentState = AppState.LOGIN_SCREEN;
    } else {
      // Unidentifiable sessions are adopted: every suite runs as the same SE, so forcing a logout
      // here would only cost a checkout+login cycle without changing who is signed in.
      currentLoggedInMobileNumber = defaultTestUser.mobileNumber;
    }
  }

  if (currentState === requiredAppState) {
    return currentState;
  }

  switch (requiredAppState) {
    case AppState.LOGIN_SCREEN:
      await loginPage.ensureLoggedOut();
      await loginPage.expectLoginScreen();
      break;
    case AppState.PRE_CHECKIN_HOME:
      if (currentState === AppState.POST_CHECKIN_HOME || currentState === AppState.CHECKOUT_SCREEN || currentState === AppState.DAY_COMPLETED) {
        await loginPage.ensureLoggedOut();
        currentState = AppState.LOGIN_SCREEN;
      }
      if (currentState === AppState.LOGIN_SCREEN) {
        await loginPage.ensureLoggedIn(defaultTestUser.mobileNumber, defaultTestUser.password);
      }
      await homePage.expectHomeScreen();
      await expect(screen.getByText('Check in for the day', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      break;
    case AppState.POST_CHECKIN_HOME:
      if (currentState === AppState.APP_CLOSED || currentState === AppState.UNKNOWN) {
        await loginPage.ensureAppVisible();
        await loginPage.dismissExitPromptIfVisible();
        currentState = await detectAppState(screen);
      }
      if (currentState === AppState.LOGIN_SCREEN) {
        await loginPage.ensureLoggedIn(defaultTestUser.mobileNumber, defaultTestUser.password);
      } else if (currentState === AppState.CHECKOUT_SCREEN || currentState === AppState.DAY_COMPLETED) {
        if (currentState === AppState.DAY_COMPLETED) {
          await new EndDayPage(screen).backToHome();
        } else {
          await screen.pressButton('BACK');
        }
        await homePage.expectHomeScreen();
        currentState = await detectAppState(screen);
      }
      if (currentState === AppState.LOGIN_SCREEN || currentState === AppState.PRE_CHECKIN_HOME) {
        await loginPage.openAppAndCompleteStartDay();
      } else if (currentState === AppState.UNKNOWN || currentState === AppState.APP_CLOSED) {
        await loginPage.recoverToHome();
        currentState = await detectAppState(screen);
        if (currentState !== AppState.POST_CHECKIN_HOME) {
          await loginPage.openAppAndCompleteStartDay();
        }
      } else {
        await homePage.expectHomeScreen();
        await homePage.expectPostCheckInState();
      }
      await homePage.expectPostCheckInState();
      break;
    case AppState.CHECKOUT_SCREEN:
      if (currentState !== AppState.POST_CHECKIN_HOME) {
        await ensureAppPrecondition(screen, AppState.POST_CHECKIN_HOME);
      }
      await homePage.openEndDay();
      break;
    case AppState.DAY_COMPLETED:
      if (currentState !== AppState.POST_CHECKIN_HOME) {
        await ensureAppPrecondition(screen, AppState.POST_CHECKIN_HOME);
      }
      await homePage.openEndDay();
      const endDayPage = new EndDayPage(screen);
      await endDayPage.captureOdometerPhoto();
      const checkoutReading = getCheckoutReading();
      const confirmedReading = await endDayPage.enterUntilConfirmation(checkoutReading);
      await endDayPage.expectConfirmationDetails(confirmedReading);
      await endDayPage.confirmEndDay();
      await endDayPage.expectEndDaySuccess();
      await endDayPage.goToDashboard();
      break;
    default:
      break;
  }

  return detectAppState(screen);
}

export async function ensureAppPreconditionWithRecovery(
  screen: Screen,
  requiredAppState: AppStateValue,
  context: string,
): Promise<AppStateValue> {
  const loginPage = new LoginPage(screen);
  try {
    return await ensureAppPrecondition(screen, requiredAppState);
  } catch (firstError) {
    console.warn(
      `${context} lightweight recovery: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
    );
  }

  await loginPage.resetApp();
  try {
    return await ensureAppPrecondition(screen, requiredAppState);
  } catch (secondError) {
    console.warn(
      `${context} hard-reset recovery: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
    );
  }

  await loginPage.hardResetApp();
  if (requiredAppState !== AppState.LOGIN_SCREEN) {
    await loginPage.ensureLoggedIn(defaultTestUser.mobileNumber, defaultTestUser.password);
  }
  return ensureAppPrecondition(screen, requiredAppState);
}

const defaultEmulatorSerial = 'emulator-5554';
let mobileCliLocationProcess: ChildProcess | undefined;
const SHORT_WAIT_MS = 300;
const MEDIUM_WAIT_MS = 800;
const APP_START_WAIT_MS = 500;

function getCheckoutReading(): string {
  const checkInReading = Number(defaultStartDayData.odometerReading);
  if (!Number.isFinite(checkInReading)) {
    throw new Error(`Invalid check-in odometer reading: ${defaultStartDayData.odometerReading}`);
  }

  const checkoutReading = checkInReading + 1000;
  if (checkoutReading <= checkInReading) {
    throw new Error(`Checkout odometer reading must be higher than check-in reading: ${checkoutReading} <= ${checkInReading}`);
  }

  return String(checkoutReading);
}

function ensureAdbServer(): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      execFileSync(adbPath, ['devices'], { encoding: 'utf8', stdio: 'pipe' });
      return;
    } catch {
      if (attempt === 0) {
        execFileSync(adbPath, ['start-server'], { stdio: 'ignore' });
      } else if (attempt === 1) {
        execFileSync(adbPath, ['kill-server'], { stdio: 'ignore' });
        execFileSync(adbPath, ['start-server'], { stdio: 'ignore' });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }

  throw new Error('ADB server did not become ready after three attempts.');
}

function execAdb(args: string[], options: { encoding?: 'utf8'; stdio?: 'ignore' | 'pipe' } = {}): string {
  ensureAdbServer();
  const result = execFileSync(adbPath, args, options as any) as string | Buffer | unknown;
  if (typeof result === 'string') {
    return result;
  }
  if (Buffer.isBuffer(result)) {
    return result.toString('utf8');
  }
  return String(result ?? '');
}

function getDeviceSerial(): string {
  try {
    const devices = execAdb(['devices'], { encoding: 'utf8' });
    const onlineDevice = devices
      .split(/\r?\n/)
      .map((line) => line.match(/^(\S+)\s+device(?:\s|$)/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => match[1])
      .find((serial) => process.env.MOBILEWRIGHT_DEVICE === 'emulator'
        ? serial.startsWith('emulator-')
        : !serial.startsWith('emulator-'));

    return onlineDevice ?? defaultEmulatorSerial;
  } catch {
    return defaultEmulatorSerial;
  }
}

// A fixed short sleep after "am start" is not reliable for a real device: a cold start with
// network/session/GPS restore can take several seconds longer than that. Poll until the app
// actually becomes the foreground activity (or the timeout elapses) instead of blindly proceeding
// against an app that hasn't rendered yet — this is shared by every code path that relaunches the
// app so none of them regress back to the "sometimes not opening"/flaky-recovery pattern.
async function waitForAppForeground(serial: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const activityDump = execAdb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' });
      const appIsForeground = /topResumedActivity=.*com\.peakline\.sfa\//i.test(activityDump)
        && !/topResumedActivity=.*com\.sec\.android\.app\.launcher/i.test(activityDump);
      if (appIsForeground) {
        return true;
      }
    } catch {
      // A transient ADB failure while the app is still launching is not itself a failure.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function mockDeviceLocation(latitude: number, longitude: number): Promise<void> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`Cannot mock an invalid location: latitude=${latitude}, longitude=${longitude}.`);
  }
  const serial = getDeviceSerial();
  if (serial.startsWith('emulator-')) {
    execAdb(['-s', serial, 'emu', 'geo', 'fix', String(longitude), String(latitude)], { stdio: 'ignore' });
    execAdb(['-s', serial, 'emu', 'geo', 'fix', String(longitude), String(latitude)], { stdio: 'ignore' });
    return;
  }
  const mobileCli = resolve(process.cwd(), 'node_modules', 'mobilecli', 'index.js');
  mobileCliLocationProcess?.kill();
  mobileCliLocationProcess = spawn(
    process.execPath,
    [mobileCli, 'device', 'location', 'set', '--device', serial, `${latitude},${longitude}`, '--wait'],
    { stdio: 'ignore', windowsHide: true },
  );
  if (!mobileCliLocationProcess.pid) {
    throw new Error('MobileCLI location agent did not start on the real device.');
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

export function clearDeviceLocation(): void {
  const serial = getDeviceSerial();
  if (serial.startsWith('emulator-')) {
    return;
  }
  if (mobileCliLocationProcess) {
    mobileCliLocationProcess.kill();
    mobileCliLocationProcess = undefined;
  }
  const mobileCli = resolve(process.cwd(), 'node_modules', 'mobilecli', 'index.js');
  execFileSync(process.execPath, [mobileCli, 'device', 'location', 'clear', '--device', serial], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

export class LoginPage {
  private readonly screen: Screen;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  async ensureAppVisible(): Promise<void> {
    const serial = getDeviceSerial();

    try {
      const activityDump = execAdb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' });
      const focusedApp = /mFocusedApp=.*com\.peakline\.sfa/i.test(activityDump);
      const resumedApp = /topResumedActivity=.*com\.peakline\.sfa\//i.test(activityDump);
      const launcherFocused = /mFocusedApp=.*com\.sec\.android\.app\.launcher|topResumedActivity=.*com\.sec\.android\.app\.launcher/i.test(activityDump);
      const appIsForeground = (focusedApp || resumedApp) && !launcherFocused;
      if (appIsForeground) {
        await this.dismissExitPromptIfVisible();
        return;
      }
    } catch {
      // The app may be inactive or partially resumed; a fresh launch is still safe.
    }

    try {
      execFileSync(adbPath, ['-s', serial, 'shell', 'am', 'start', '-n', 'com.peakline.sfa/.MainActivity'], {
        stdio: 'ignore',
      });
    } catch {
      try {
        execFileSync(adbPath, ['-s', serial, 'shell', 'am', 'start', 'com.peakline.sfa/.MainActivity'], {
          stdio: 'ignore',
        });
      } catch {
        execFileSync(adbPath, ['-s', serial, 'shell', 'monkey', '-p', 'com.peakline.sfa', '-c', 'android.intent.category.LAUNCHER', '1'], {
          stdio: 'ignore',
        });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, APP_START_WAIT_MS));

    const launchedInForeground = await waitForAppForeground(serial);
    if (!launchedInForeground) {
      console.log('ensureAppVisible: app did not report as foreground within 15s of launching; continuing so the caller\'s own state check can retry.');
    }

    await this.selectBackgroundLocationIfSettingsOpened();
    await this.dismissExitPromptIfVisible();
  }

  async recoverToHome(): Promise<void> {
    const homePage = new HomePage(this.screen);
    await this.ensureAppVisible();
    await this.dismissExitPromptIfVisible();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      // Check the same full set of Home indicators expectHomeScreen recognizes (not just 3 of them);
      // otherwise a scrolled Home screen showing only e.g. "Today's route"/"Profile" was wrongly
      // treated as "not home", triggering an unnecessary Home tap or BACK press (and risking the
      // "Exit App" prompt) while already on the Home screen.
      if (await homePage.expectHomeScreen(500).then(() => true).catch(() => false)) {
        return;
      }

      // A leftover open dropdown/bottom-sheet (e.g. a closure-reason selector) can swallow both Home
      // taps and BACK presses. Dismiss any visible close/cancel affordance first so navigation below
      // actually reaches the Home tab instead of being absorbed by the overlay.
      const overlayDismissCandidates = [
        this.screen.getByText('CANCEL', { exact: true }),
        this.screen.getByText('Cancel', { exact: true }),
        this.screen.getByLabel('Close'),
        this.screen.getByLabel('close'),
        // A nested, unsubmitted Visit task screen (e.g. an expanded SKU stock/facing form) has neither
        // a Home tab nor a reliable BACK path, causing this loop to exhaust and fall back to a jarring
        // force-close+relaunch; submitting/saving the in-progress task first exits it cleanly instead.
        this.screen.getByText('Submit Task', { exact: true }),
        this.screen.getByText('Save', { exact: true }),
        this.screen.getByLabel('Back'),
        this.screen.getByLabel('back'),
        this.screen.getByLabel('Navigate up'),
        this.screen.getByLabel('Navigate back'),
      ];
      for (const dismiss of overlayDismissCandidates) {
        if (await dismiss.isVisible({ timeout: 300 }).catch(() => false)) {
          await dismiss.tap().catch(() => undefined);
          break;
        }
      }

      const tappedHome = await tapAppHomeTab(this.screen);

      if (!tappedHome) {
        try {
          await this.screen.pressButton('BACK');
        } catch {
          // The current screen may already be closing; the next iteration rechecks Home.
        }
      }

      const exitPromptDismissed = await this.dismissExitPromptIfVisible();

      // A BACK press can occasionally background the whole app instead of just popping the current
      // screen; if that happened, relaunch immediately instead of burning the rest of this attempt
      // pressing BACK again on the launcher (which does nothing useful and just wastes time).
      if (await this.isAppClosedToLauncher()) {
        await this.ensureAppVisible();
      }

      // BACK from an already-settled Home root re-triggers the "Exit App" prompt every time (it isn't
      // backgrounding the app). If we just dismissed that prompt, give the UI a brief moment to settle
      // before the Home check below, instead of immediately looping into another BACK press that would
      // just show the same prompt again — this was the cause of a real run getting stuck tapping
      // "Exit App" cancel a dozen times in a row and eventually timing out the whole test.
      if (exitPromptDismissed) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }

      // Use a short timeout here (not the default 15s) since this is one check inside an up-to-8
      // attempt loop; a long per-attempt wait here was the main cause of "hanging"/very slow recovery
      // when the app was slow to reach Home. The loop itself provides the retries.
      if (await homePage.expectHomeScreen(exitPromptDismissed ? 3_000 : 1_500).then(() => true).catch(() => false)) {
        return;
      }
    }

    // Some screens (e.g. MJP's Today's Plan/Calendar View) expose neither a bottom-nav Home tab nor a
    // BACK path that reliably returns to Home within a handful of lightweight attempts. Rather than
    // leaving the app stuck in that state for the next test (which is what previously surfaced as
    // "Unable to recover"/hangs), fall back to a full force-close + relaunch once, since that always
    // returns the app to a known, recoverable state (login or Home) regardless of what screen it was
    // stuck on.
    console.log('recoverToHome: lightweight recovery attempts exhausted; force-closing and relaunching as a last resort.');
    await forceCloseApp();
    await this.ensureAppVisible();
    await this.dismissExitPromptIfVisible();
    if (await homePage.expectHomeScreen(10_000).then(() => true).catch(() => false)) {
      return;
    }

    throw new Error('Unable to recover the authenticated application to the Home screen.');
  }

  async openAppOnce(): Promise<void> {
    await this.ensureAppVisible();
  }

  private async selectBackgroundLocationIfSettingsOpened(): Promise<void> {
    const serial = getDeviceSerial();

    try {
      const activities = execAdb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], {
        encoding: 'utf8',
      });
      const permissionScreenIsForeground = /topResumedActivity=.*(?:permissioncontroller|com\.android\.settings)/i.test(activities);
      if (!permissionScreenIsForeground) return;

      execAdb(['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/permission-settings.xml'], {
        stdio: 'ignore',
      });
      const hierarchy = execAdb(['-s', serial, 'shell', 'cat', '/sdcard/permission-settings.xml'], {
        encoding: 'utf8',
      });

      if (!/Location permission|Allow only while using the app|Allow all the time/i.test(hierarchy)) return;

      const allowAllTimeNode = (hierarchy.match(/<node\b[^>]*text="Allow all the time"[^>]*>/i) ?? [])[0];
      const bounds = allowAllTimeNode?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);

      if (bounds) {
        const x = Math.round((Number(bounds[1]) + Number(bounds[3])) / 2);
        const y = Math.round((Number(bounds[2]) + Number(bounds[4])) / 2);
        execAdb(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], { stdio: 'ignore' });
        await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS));
      }

      for (const packageName of [
        'com.android.settings',
        'com.android.permissioncontroller',
        'com.google.android.permissioncontroller',
      ]) {
        try {
          execAdb(['-s', serial, 'shell', 'am', 'force-stop', packageName], { stdio: 'ignore' });
        } catch {
          // The package name varies by Android build.
        }
      }
      execAdb(['-s', serial, 'shell', 'am', 'start', '-n', 'com.peakline.sfa/.MainActivity'], { stdio: 'ignore' });
    } catch {
      // The permission settings page may not be present on every Android build.
    }
  }

  async forceCloseApp(): Promise<void> {
    await forceCloseApp();
  }

  async resetApp(): Promise<void> {
    await this.forceCloseApp();
    await this.openAppOnce();
  }

  // Escalation-only hard reset: force-close, wipe all app data, re-grant the permissions the app
  // needs, then relaunch. Use this when a lighter force-close + relaunch left the app in a state that
  // still isn't recognizable (stuck dialog, crash, etc); a plain force-stop preserves local state and
  // so can come back to that same broken screen, while this guarantees a truly clean app like a fresh
  // install.
  async hardResetApp(): Promise<void> {
    await forceCloseAndClearAppData();
    await this.grantDevicePermissions();
    await this.ensureAppVisible();
  }

  async detectAppState(): Promise<AppStateValue> {
    return detectAppState(this.screen);
  }

  async clearSessionAndOpen(): Promise<void> {
    const serial = getDeviceSerial();
    execAdb(['-s', serial, 'shell', 'am', 'force-stop', 'com.peakline.sfa'], { stdio: 'ignore' });
    execAdb(['-s', serial, 'shell', 'pm', 'clear', 'com.peakline.sfa'], { stdio: 'ignore' });
    await this.grantDevicePermissions();
    await this.dismissExitPromptIfVisible();
    await this.openAppOnce();
  }

  async grantDevicePermissions(): Promise<void> {
    const serial = getDeviceSerial();

    for (const permission of [
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
    ]) {
      for (const flag of ['user-fixed', 'user-set']) {
        try {
          execAdb(['-s', serial, 'shell', 'pm', 'clear-permission-flags', 'com.peakline.sfa', permission, flag], {
            stdio: 'ignore',
          });
        } catch {
          // Some Android versions do not expose permission flags through ADB.
        }
      }
    }

    for (const permission of [
      'android.permission.CAMERA',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.POST_NOTIFICATIONS',
    ]) {
      try {
        execAdb(['-s', serial, 'shell', 'pm', 'grant', 'com.peakline.sfa', permission], {
          stdio: 'ignore',
        });
      } catch {
        // Older Android builds may not declare POST_NOTIFICATIONS.
      }
    }

    execAdb(['-s', serial, 'shell', 'settings', 'put', 'secure', 'location_mode', '3'], {
      stdio: 'ignore',
    });
    execAdb(['-s', serial, 'shell', 'appops', 'set', 'com.peakline.sfa', 'android:fine_location', 'allow'], {
      stdio: 'ignore',
    });
    execAdb(['-s', serial, 'shell', 'appops', 'set', 'com.peakline.sfa', 'android:coarse_location', 'allow'], {
      stdio: 'ignore',
    });
    try {
      execAdb(['-s', serial, 'shell', 'appops', 'set', 'com.peakline.sfa', 'android:background_location', 'allow'], {
        stdio: 'ignore',
      });
    } catch {
      // Background location may be unavailable on this Android build.
    }
    try {
      execAdb(['-s', serial, 'shell', 'appops', 'set', 'com.peakline.sfa', 'android:post_notification', 'allow'], {
        stdio: 'ignore',
      });
    } catch {
      // Older Android builds may not expose the notification AppOp.
    }
    for (const permissionController of ['com.android.permissioncontroller', 'com.google.android.permissioncontroller']) {
      try {
        execFileSync(adbPath, ['-s', serial, 'shell', 'am', 'force-stop', permissionController], { stdio: 'ignore' });
      } catch {
        // The permission controller package name varies by Android build.
      }
    }
  }

  private async recoverFromEmptyUiDump(): Promise<void> {
    const serial = getDeviceSerial();
    try {
      execAdb(['-s', serial, 'shell', 'am', 'force-stop', 'com.peakline.sfa'], { stdio: 'ignore' });
    } catch {
      // Ignore force-stop failures when the app is already closing.
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    try {
      execAdb(['-s', serial, 'shell', 'am', 'start', '-n', 'com.peakline.sfa/.MainActivity'], {
        stdio: 'ignore',
      });
    } catch {
      try {
        execAdb(['-s', serial, 'shell', 'am', 'start', 'com.peakline.sfa/.MainActivity'], {
          stdio: 'ignore',
        });
      } catch {
        execAdb(['-s', serial, 'shell', 'monkey', '-p', 'com.peakline.sfa', '-c', 'android.intent.category.LAUNCHER', '1'], {
          stdio: 'ignore',
        });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  private async waitForUsableUi(timeoutMs = 20_000): Promise<void> {
    const startedAt = Date.now();
    const numberField = this.screen.getByPlaceholder('Enter mobile number');
    const passwordField = this.screen.getByPlaceholder('Enter password');

    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (await numberField.isVisible({ timeout: 300 }).catch(() => false) && await passwordField.isVisible({ timeout: 300 }).catch(() => false)) {
          return;
        }
      } catch {
        // A transient UI dump is not itself a failure when the login inputs are visible and usable.
      }

      const serial = getDeviceSerial();
      try {
        const activityDump = execAdb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], {
          encoding: 'utf8',
        });
        const appClosed = !/com\.peakline\.sfa/i.test(activityDump) || /topResumedActivity=.*com\.sec\.android\.app\.launcher/i.test(activityDump);
        if (appClosed) {
          await this.ensureAppVisible();
        }
      } catch {
        // The app may not be fully launched yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async expectLoginScreen(maxAttempts = 15): Promise<void> {
    console.log('Waiting for login screen');
    await this.dismissExitPromptIfVisible();
    const mobileNumber = this.screen.getByPlaceholder('Enter mobile number');
    const password = this.screen.getByPlaceholder('Enter password');
    const loginButton = this.screen.getByText('Log in');
    const disclosureButton = this.screen.getByText(/I Agree/i);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.dismissExitPromptIfVisible();

        if (await disclosureButton.isVisible({ timeout: 300 }).catch(() => false)) {
          await disclosureButton.tap();
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }

        if (await this.screen.getByText(/Allow|While using the app|Only this time/i).isVisible({ timeout: 300 }).catch(() => false)) {
          await this.allowPostLoginPrompts();
          continue;
        }

        await expect(mobileNumber).toBeVisible({ timeout: 300 });
        await expect(password).toBeVisible({ timeout: 300 });
        await expect(loginButton).toBeVisible({ timeout: 300 });
        console.log('Login screen is ready');
        return;
      } catch {
        // Keep polling until the complete login form becomes available.
      }
      await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS));
    }

    throw new Error('Complete login form did not appear within the expected time window.');
  }

  async expectPasswordMasked(masked = true): Promise<void> {
    const passwordInput = this.screen.getByPlaceholder('Enter password');
    await expect(passwordInput).toBeVisible({ timeout: 20_000 });

    const toggleText = masked ? 'Show' : 'Hide';
    await expect(this.screen.getByText(toggleText)).toBeVisible({ timeout: 10_000 });
  }

  async togglePasswordVisibility(): Promise<void> {
    const toggle = this.screen.getByText(/Show|Hide/i);
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await toggle.tap();
    await this.expectPasswordMasked(false);
  }

  async expectMobileNumberReading(mobileNumber: string): Promise<void> {
    const field = this.screen.getByPlaceholder('Enter mobile number');
    await expect(field).toBeVisible({ timeout: 20_000 });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const value = await field.getValue().catch(() => '');
      const text = await field.getText().catch(() => '');
      if (value === mobileNumber || text === mobileNumber) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const value = await field.getValue().catch(() => '');
    const text = await field.getText().catch(() => '');
    expect(value || text).toBe(mobileNumber);
  }

  async expectValidationMessage(expectedText: string): Promise<string> {
    const message = this.screen.getByTestId('android:id/message');
    await expect(message).toBeVisible({ timeout: 20_000 });

    const actualText = await message.getText();
    expect(actualText).toContain(expectedText);

    const dismissCandidates = [
      this.screen.getByRole('button', { name: 'OK' }),
      this.screen.getByText('OK', { exact: true }),
      this.screen.getByRole('button', { name: 'Close' }),
      this.screen.getByText('Close', { exact: true }),
    ];

    for (const dismiss of dismissCandidates) {
      if (await dismiss.isVisible({ timeout: 500 }).catch(() => false)) {
        await dismiss.tap();
        break;
      }
    }

    return actualText;
  }

  async expectAuthenticationRejected(expectedText = 'User not found|Invalid password|not found|invalid password'): Promise<void> {
    const profile = this.screen.getByLabel('Profile');
    const markAttendance = this.screen.getByText('Mark attendance');
    const message = this.screen.getByTestId('android:id/message');

    await expect(message).toBeVisible({ timeout: 20_000 });
    const actualText = (await message.getText()).toLowerCase();
    expect(actualText).toMatch(new RegExp(expectedText.toLowerCase(), 'i'));

    await new Promise((resolve) => setTimeout(resolve, MEDIUM_WAIT_MS));
    expect(await profile.isVisible({ timeout: 1_000 }).catch(() => false)).toBeFalsy();
    expect(await markAttendance.isVisible({ timeout: 1_000 }).catch(() => false)).toBeFalsy();
  }

  async login(mobileNumber: string, password: string): Promise<void> {
    await this.dismissExitPromptIfVisible();
    await this.waitForUsableUi(15_000);
    const numberField = this.screen.getByPlaceholder('Enter mobile number');
    const passwordField = this.screen.getByPlaceholder('Enter password');

    if (!(await numberField.isVisible({ timeout: 5_000 }).catch(() => false)) || !(await passwordField.isVisible({ timeout: 5_000 }).catch(() => false))) {
      await this.ensureAppVisible();
      await this.expectLoginScreen(10);
    }

    console.log('Login form is visible; entering mobile number');
    await numberField.fill(mobileNumber);
    console.log('Mobile number entered; entering password');
    await passwordField.fill(password);
    console.log('Password entered; submitting login');
    await this.screen.getByLabel('Log in').tap();
  }

  async dismissExitPromptIfVisible(): Promise<boolean> {
    return dismissExitPromptIfVisible(this.screen);
  }

  async forceRecoverFromExitPrompt(): Promise<void> {
    if (await this.dismissExitPromptIfVisible()) {
      await this.dismissExitPromptIfVisible();
      return;
    }

    const exitPrompt = this.screen.getByText(/Exit App|Exit app|Are you sure you want to exit the app/i);
    if (await exitPrompt.isVisible({ timeout: 500 }).catch(() => false)) {
      await this.dismissExitPromptIfVisible();
    }
  }

  async submitEmptyLogin(): Promise<void> {
    const numberField = this.screen.getByPlaceholder('Enter mobile number');
    const passwordField = this.screen.getByPlaceholder('Enter password');

    await expect(numberField).toBeVisible({ timeout: 20_000 });
    await expect(passwordField).toBeVisible({ timeout: 20_000 });
    await numberField.clear();
    await passwordField.clear();
    await this.screen.getByText('Log in').tap();
  }

  async isLoggedIn(): Promise<boolean> {
    const homeIndicators = [
      this.screen.getByLabel('Profile'),
      this.screen.getByText('Mark attendance'),
      this.screen.getByLabel('Check in for the day'),
      this.screen.getByLabel('Check out for the day'),
      this.screen.getByText("Today's route"),
    ];

    for (const indicator of homeIndicators) {
      if (await indicator.isVisible({ timeout: 500 }).catch(() => false)) return true;
    }

    return false;
  }

  // Reads the "Good morning, {name}" greeting shown on the pre-check-in home screen, or falls back to
  // the Profile menu (which lists the SE's name) once checked in, to identify the active session's
  // owner without needing debug access to the app's persisted session data.
  async getActiveSeName(): Promise<string | undefined> {
    const greeting = this.screen.getByText(/Good morning,|Good afternoon,|Good evening,/i);
    if (await greeting.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const text = await greeting.getText().catch(() => '');
      const match = text.match(/Good (?:morning|afternoon|evening),\s*(.+)/i);
      if (match?.[1]?.trim()) return match[1].trim();
    }

    const profileIcon = this.screen.getByLabel('Profile');
    const configuredName = process.env.MOBILE_TEST_USER_NAME?.trim();
    if (!configuredName || !(await profileIcon.isVisible({ timeout: 1_000 }).catch(() => false))) {
      return undefined;
    }
    await profileIcon.tap();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const foundName = await this.screen.getByText(configuredName, { exact: true })
      .isVisible({ timeout: 1_000 })
      .then((visible) => visible ? configuredName : undefined)
      .catch(() => undefined);
    await this.dismissExitPromptIfVisible();
    await this.screen.pressButton('BACK').catch(() => undefined);
    return foundName;
  }

  async ensureLoggedIn(mobileNumber: string, password: string): Promise<void> {
    if (!mobileNumber || !password) {
      throw new Error('Set MOBILE_TEST_USER and MOBILE_TEST_PASSWORD before running authenticated mobile flows.');
    }
    const loginStartedAt = Date.now();
    console.log('Starting login flow');
    await this.ensureAppVisible();

    if (currentLoggedInMobileNumber === mobileNumber && (await this.isLoggedIn())) {
      console.log(`Already authenticated as ${mobileNumber}; skipping logout/login cycle.`);
      return;
    }

    if (await this.isLoggedIn()) {
      const expectedName = getSeNameForMobileNumber(mobileNumber);
      const activeName = await this.getActiveSeName();
      // The whole suite authenticates as a single SE, so an existing session is almost always the
      // right one. Only tear it down when we can positively prove it belongs to somebody else --
      // an unidentifiable session (no MOBILE_TEST_USER_NAME configured, or the greeting/profile
      // simply wasn't readable) must be adopted rather than forcing an expensive and failure-prone
      // checkout+logout+login cycle on every run.
      const belongsToAnotherUser = Boolean(expectedName && activeName && expectedName !== activeName);
      if (!belongsToAnotherUser) {
        console.log(
          `Reusing the active session for ${mobileNumber}`
          + `${activeName ? ` (signed in as ${activeName})` : ' (active user could not be identified)'}.`,
        );
        currentLoggedInMobileNumber = mobileNumber;
        return;
      }
      console.log(`Existing session belongs to ${activeName}, but ${expectedName} (${mobileNumber}) is configured; logging out before continuing login`);
      await this.ensureLoggedOut();
    }

    try {
      await this.expectLoginScreen();
    } catch {
      console.log('Login screen not visible; re-opening the app before retrying login');
      await this.ensureAppVisible();
      try {
        await this.expectLoginScreen();
      } catch {
        console.log('Login screen still not visible after relaunch; escalating to a hard reset (clear app data) before retrying.');
        await this.hardResetApp();
        await this.expectLoginScreen();
      }
    }

    console.log('Submitting credentials');
    try {
      await this.login(mobileNumber, password);
    } catch (error) {
      console.log(`Login form was unstable; re-opening the app and retrying once: ${(error as Error).message ?? String(error)}`);
      await this.ensureAppVisible();
      await this.expectLoginScreen();
      await this.login(mobileNumber, password);
    }
    console.log(`Credentials submitted after ${Date.now() - loginStartedAt}ms; waiting for post-login prompts`);
    await this.dismissExitPromptIfVisible();
    await this.allowPostLoginPrompts();
    console.log(`Post-login prompts handled after ${Date.now() - loginStartedAt}ms; waiting for home screen`);
    await this.acceptDataLocationDisclosure(mobileNumber, password);
    await this.dismissExitPromptIfVisible();
    currentLoggedInMobileNumber = mobileNumber;
    console.log(`Login flow complete after ${Date.now() - loginStartedAt}ms`);
  }

  async recoverSession(mobileNumber: string, password: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.dismissExitPromptIfVisible();
        await this.ensureAppVisible();

        if (await this.screen.getByPlaceholder('Enter mobile number').isVisible({ timeout: 2_000 }).catch(() => false)) {
          await this.login(mobileNumber, password);
          await this.dismissExitPromptIfVisible();
          await this.allowPostLoginPrompts();
          await this.acceptDataLocationDisclosure(mobileNumber, password);
          await this.dismissExitPromptIfVisible();
          if (await this.isLoggedIn()) {
            currentLoggedInMobileNumber = mobileNumber;
            return;
          }
        }

        if (await this.isLoggedIn()) {
          return;
        }
      } catch (error) {
        console.log(`recoverSession attempt ${attempt + 1} failed: ${(error as Error).message ?? String(error)}`);
      }

      if (!(await this.isAppClosedToLauncher())) {
        break;
      }

      execAdb(['-s', getDeviceSerial(), 'shell', 'am', 'start', '-n', 'com.peakline.sfa/.MainActivity'], {
        stdio: 'ignore',
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    throw new Error('Unable to recover the app to a valid home screen after repeated login attempts.');
  }

  async recoverToHomeScreen(mobileNumber: string, password: string): Promise<void> {
    const homePage = new HomePage(this.screen);

    await this.dismissExitPromptIfVisible();
    await this.ensureAppVisible();

    if (await this.isLoggedIn()) {
      await homePage.returnHome();
      await homePage.expectHomeScreen();
      return;
    }

    if (await this.screen.getByPlaceholder('Enter mobile number').isVisible({ timeout: 2_000 }).catch(() => false)) {
      await this.login(mobileNumber, password);
      await this.dismissExitPromptIfVisible();
      await this.allowPostLoginPrompts();
      await this.acceptDataLocationDisclosure(mobileNumber, password);
      await this.dismissExitPromptIfVisible();
      currentLoggedInMobileNumber = mobileNumber;
    }

    await homePage.returnHome();
    await homePage.expectHomeScreen();
  }

  async loginFromCleanState(mobileNumber: string, password: string): Promise<void> {
    await this.expectLoginScreen();
    await this.login(mobileNumber, password);
    await this.allowPostLoginPrompts();
    await this.acceptDataLocationDisclosure();
    currentLoggedInMobileNumber = mobileNumber;
  }

  async ensureCheckedOutThenLoggedOut(): Promise<void> {
    const homePage = new HomePage(this.screen);
    const endDayPage = new EndDayPage(this.screen);

    await this.dismissExitPromptIfVisible();

    if (await homePage.isEndDayAvailable()) {
      await homePage.openEndDay();
      await endDayPage.captureOdometerPhoto();

      const checkoutReading = getCheckoutReading();
      const confirmedReading = await endDayPage.enterUntilConfirmation(checkoutReading);
      await endDayPage.expectConfirmationDetails(confirmedReading);
      await endDayPage.confirmEndDay();
      await endDayPage.expectEndDaySuccess();
      await endDayPage.goToDashboard();
      await homePage.returnHome();
      await homePage.expectHomeScreen();
    }

    await this.ensureLoggedOut();
  }

  async ensureLoggedOut(): Promise<void> {
    currentLoggedInMobileNumber = undefined;
    await this.dismissExitPromptIfVisible();
    await this.ensureAppVisible();

    const homePage = new HomePage(this.screen);
    const endDayPage = new EndDayPage(this.screen);

    let appState = await detectAppState(this.screen);
    if (appState === AppState.LOGIN_SCREEN) {
      console.log('Session state: login');
      return;
    }

    if (appState === AppState.POST_CHECKIN_HOME || appState === AppState.CHECKOUT_SCREEN) {
      console.log('Checked-in session detected; completing checkout before logout');
      if (appState === AppState.POST_CHECKIN_HOME) {
        await homePage.openEndDay();
      }
      await this.completeCheckout(endDayPage);
      await this.ensureAppVisible();
      appState = await detectAppState(this.screen);
      if (appState === AppState.DAY_COMPLETED) {
        await endDayPage.backToHome();
        appState = await detectAppState(this.screen);
      }
      if (appState !== AppState.PRE_CHECKIN_HOME && appState !== AppState.LOGIN_SCREEN) {
        throw new Error(`Checkout did not finish; application state is ${appState}.`);
      }
    }

    console.log('Session is checked-out; logging out');
    if (await this.screen.getByPlaceholder('Enter mobile number').isVisible({ timeout: 1_000 }).catch(() => false)) {
      return;
    }

    if (appState !== AppState.PRE_CHECKIN_HOME) {
      await this.ensureAppVisible();
      appState = await detectAppState(this.screen);
    }
    if (appState === AppState.DAY_COMPLETED) {
      await endDayPage.backToHome();
    }
    const profile = this.screen.getByLabel('Profile');

    if (!(await profile.isVisible({ timeout: 5_000 }).catch(() => false))) {
      await this.ensureAppVisible();
    }

    if (await profile.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await profile.tap();
      await this.dismissExitPromptIfVisible();
      const logoutAction = this.screen.getByLabel('Log out');
      if (await logoutAction.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await logoutAction.tap();
      }
      await this.dismissExitPromptIfVisible();
      const logoutConfirm = this.screen.getByRole('button', { name: 'LOGOUT' });
      if (await logoutConfirm.isVisible({ timeout: 15_000 }).catch(() => false)) {
        await logoutConfirm.tap();
      }
    } else {
      throw new Error(`Unable to find the Profile control while logging out from ${appState}.`);
    }

    await this.dismissExitPromptIfVisible();

    try {
      await this.expectLoginScreen(5);
      return;
    } catch {
      throw new Error('Logout did not return the app to the login screen; refusing to relaunch the app.');
    }
  }

  private async completeCheckout(endDayPage: EndDayPage): Promise<void> {
    const homePage = new HomePage(this.screen);
    const captureAction = this.screen.getByText('Capture Odometer Photo', { exact: true });

    if (!(await captureAction.isVisible({ timeout: 2_000 }).catch(() => false))) {
      // "Check out for the day" stays unavailable while a visit is still in progress, so any active
      // visit has to be ended first or the checkout below can never start.
      const { VisitPage } = await import('./visit.page.js');
      await new VisitPage(this.screen).endAnyActiveVisit().catch(() => false);

      const checkoutAction = this.screen.getByText('Check out for the day', { exact: true });
      if (await checkoutAction.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await homePage.openEndDay();
      } else {
        await this.ensureAppVisible();
        await endDayPage.expectEndDayScreen();
      }
    }

    await endDayPage.captureOdometerPhoto();

    const checkoutReading = getCheckoutReading();
    console.log(`Checkout: entering odometer reading ${checkoutReading}.`);
    const confirmedReading = await endDayPage.enterUntilConfirmation(checkoutReading);
    console.log(`Checkout: confirmation screen reached with reading ${confirmedReading}.`);
    await endDayPage.expectConfirmationDetails(confirmedReading);
    await endDayPage.confirmEndDay();
    await endDayPage.expectEndDaySuccess();

    const dashboard = this.screen.getByText(/Go to dashboard/i);
    if (await dashboard.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await dashboard.tap();
    }
  }

  async attemptFailedLogins(mobileNumber: string, password: string, attempts: number): Promise<string> {
    const maxAttempts = Math.min(attempts, 6);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.expectLoginScreen(4);
      } catch {
        const dialogMessage = this.screen.getByTestId('android:id/message');
        const actualText = await dialogMessage.getText().catch(() => '');
        if (/lock|too many|throttl|wait|temporar|try again/i.test(actualText)) {
          return actualText;
        }

        try {
          await this.screen.getByText('OK').tap({ timeout: 1_500 });
        } catch {
          // The app may dismiss the rejection automatically.
        }
      }

      try {
        await this.login(mobileNumber, password);
      } catch {
        try {
          await this.expectLoginScreen(4);
          await this.login(mobileNumber, password);
        } catch {
          // Continue to the next login attempt if the screen is not stable yet.
        }
      }

      const message = this.screen.getByTestId('android:id/message');
      const actualText = await message.getText().catch(() => '');
      if (/lock|too many|throttl|wait|temporar|try again/i.test(actualText)) {
        return actualText;
      }

      try {
        await this.screen.getByText('OK').tap({ timeout: 1_000 });
      } catch {
        // Continue after a rejection that has no dismiss button.
      }
    }

    const fallbackOpen = this.screen.getByTestId('android:id/message');
    const fallbackText = await fallbackOpen.getText().catch(() => '');
    if (/lock|too many|throttl|wait|temporar|try again/i.test(fallbackText)) {
      return fallbackText;
    }

    throw new Error(`No lockout/throttling message appeared after ${maxAttempts} failed login attempts.`);
  }

  async allowPostLoginPrompts(): Promise<void> {
    const allowButtons = [
      'Allow',
      'Allow all the time',
      'Allow only while using the app',
      'Allow while using the app',
      'While using the app',
      'Only this time',
      'Allow notifications',
      'Allow access to camera',
      'Allow access to photos and videos',
      'Allow access to your location',
      'Allow location access',
      'OK',
      'Continue',
      'Yes',
    ];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let tappedPrompt = false;

      for (const label of allowButtons) {
        const button = this.screen.getByText(label);
        if (await button.isVisible({ timeout: 200 }).catch(() => false)) {
          await button.tap();
          tappedPrompt = true;
          break;
        }
      }

      if (!tappedPrompt) {
        const genericAllow = this.screen.getByText(/allow|while using the app|only this time|notifications|camera|location/i);
        if (await genericAllow.isVisible({ timeout: 200 }).catch(() => false)) {
          await genericAllow.tap();
          tappedPrompt = true;
        }
      }

      if (!tappedPrompt) return;
      await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS));
    }
  }

  private async isAppClosedToLauncher(): Promise<boolean> {
    const serial = getDeviceSerial();
    try {
      const activityDump = execAdb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], {
        encoding: 'utf8',
      });
      return !/com\.peakline\.sfa/i.test(activityDump) || /topResumedActivity=.*com\.sec\.android\.app\.launcher/i.test(activityDump);
    } catch {
      return false;
    }
  }

  private async relaunchAfterDisclosureIfNeeded(mobileNumber?: string, password?: string): Promise<boolean> {
    if (!(await this.isAppClosedToLauncher())) {
      return false;
    }

    const serial = getDeviceSerial();
    console.log('App closed after I Agree; relaunching once and continuing without resetting app data');
    execAdb(['-s', serial, 'shell', 'am', 'start', '-n', 'com.peakline.sfa/.MainActivity'], { stdio: 'ignore' });
    // Poll for the app actually reaching the foreground instead of a fixed sleep — a real-device
    // relaunch here was flaky/slow for the same reason ensureAppVisible's original fixed wait was.
    if (!(await waitForAppForeground(serial))) {
      console.log('relaunchAfterDisclosureIfNeeded: app did not report as foreground within 15s of relaunching; continuing anyway.');
    }
    await this.dismissExitPromptIfVisible();

    if (mobileNumber && password && (await this.screen.getByPlaceholder('Enter mobile number').isVisible({ timeout: 2_000 }).catch(() => false))) {
      await this.login(mobileNumber, password);
      await this.dismissExitPromptIfVisible();
      await this.allowPostLoginPrompts();
      await this.dismissExitPromptIfVisible();
    }

    return true;
  }

  async acceptDataLocationDisclosure(mobileNumber?: string, password?: string): Promise<void> {
    const disclosureAccepted = await this.acceptDataLocationDisclosureIfVisible(mobileNumber, password);
    if (disclosureAccepted) {
      await this.dismissExitPromptIfVisible();
      if (await this.relaunchAfterDisclosureIfNeeded(mobileNumber, password)) {
        await this.allowPostLoginPrompts();
      }
      else {
        await this.allowPostLoginPrompts();
      }
      await this.dismissExitPromptIfVisible();
    }

    if (await this.relaunchAfterDisclosureIfNeeded(mobileNumber, password)) {
      await this.allowPostLoginPrompts();
      await this.dismissExitPromptIfVisible();
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await this.dismissExitPromptIfVisible();

      if (await this.isLoggedIn()) {
        await this.dismissExitPromptIfVisible();
        return;
      }

      const serial = getDeviceSerial();
      const activityDump = execAdb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], {
        encoding: 'utf8',
      });
      const appIsClosed = !/com\.peakline\.sfa/i.test(activityDump) || /topResumedActivity=.*com\.sec\.android\.app\.launcher/i.test(activityDump);

      if (appIsClosed && (await this.relaunchAfterDisclosureIfNeeded(mobileNumber, password))) {
        continue;
      }

      if (mobileNumber && password && (await this.screen.getByPlaceholder('Enter mobile number').isVisible({ timeout: 300 }).catch(() => false))) {
        console.log('App closed after disclosure; re-entering credentials to recover login');
        await this.login(mobileNumber, password);
        await this.dismissExitPromptIfVisible();
        await this.allowPostLoginPrompts();
        await this.dismissExitPromptIfVisible();
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await expect(this.screen.getByText('Mark attendance')).toBeVisible({ timeout: 30_000 });
    await this.dismissExitPromptIfVisible();
  }

  private async acceptDataLocationDisclosureIfVisible(mobileNumber?: string, password?: string): Promise<boolean> {
    const agreeButtons = [
      this.screen.getByLabel('I Agree'),
      this.screen.getByText('I Agree', { exact: true }),
      this.screen.getByRole('button', { name: 'I Agree' }),
    ];
    const disclosureText = this.screen.getByText(/data|location|privacy/i);
    let disclosureSeen = false;
    console.log('Checking for data and location disclosure');

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await this.dismissExitPromptIfVisible();

      // The disclosure is optional and normally absent after the first successful login. As soon as
      // Home is rendered, stop polling instead of spending up to 20 cycles proving that no disclosure
      // will appear after an already-completed login.
      if (!disclosureSeen && await this.isLoggedIn()) {
        return false;
      }

      for (const agreeButton of agreeButtons) {
        if (await agreeButton.isVisible({ timeout: 300 }).catch(() => false)) {
          console.log('Data and location disclosure is visible; tapping I Agree');
          try {
            await agreeButton.tap();
          } catch (error) {
            const serial = getDeviceSerial();
            const activityDump = execAdb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], {
              encoding: 'utf8',
            });
            const appIsClosed = !/com\.peakline\.sfa/i.test(activityDump) || /topResumedActivity=.*com\.sec\.android\.app\.launcher/i.test(activityDump);
            if (appIsClosed && mobileNumber && password && (await this.relaunchAfterDisclosureIfNeeded(mobileNumber, password))) {
              return true;
            }
            throw error;
          }
          await this.dismissExitPromptIfVisible();
          await new Promise((resolve) => setTimeout(resolve, 300));
          return true;
        }
      }

      if (!disclosureSeen && (await disclosureText.isVisible({ timeout: 300 }).catch(() => false))) {
        disclosureSeen = true;
        console.log('Data and location disclosure detected; waiting for I Agree');
      }

      if (!disclosureSeen && attempt >= 19) return false;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    console.log('No data and location disclosure was shown');
    return false;
  }

  async handleDisclosureAndAppStart(): Promise<void> {
    await this.dismissExitPromptIfVisible();
    await this.acceptDataLocationDisclosure();
  }

  async waitForSessionState(): Promise<'login' | 'checked-out' | 'checked-in' | 'checkout-screen'> {
    const login = this.screen.getByPlaceholder('Enter mobile number');
    const checkoutScreen = this.screen.getByText(/End Day|Enter current reading|Capture Odometer Photo/i);
    const checkedIn = this.screen.getByText('Check out for the day', { exact: true });
    const checkedOut = this.screen.getByText('Check in for the day', { exact: true });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await login.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log('Session state: login');
        return 'login';
      }
      if (await checkoutScreen.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log('Session state: checkout-screen');
        return 'checkout-screen';
      }
      if (await checkedIn.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log('Session state: checked-in');
        return 'checked-in';
      }
      if (await checkedOut.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log('Session state: checked-out');
        return 'checked-out';
      }
      await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS));
    }

    throw new Error('Unable to determine the application session state after opening the app.');
  }

  async openAppAndCompleteStartDay(): Promise<{ homePage: HomePage; startDayPage: StartDayPage }> {
    const homePage = new HomePage(this.screen);
    const startDayPage = new StartDayPage(this.screen);

    await this.dismissExitPromptIfVisible();
    await this.ensureAppVisible();
    await this.dismissExitPromptIfVisible();
    console.log('MJP setup: app opened');

    const isLoginVisible = await this.screen.getByPlaceholder('Enter mobile number').isVisible({ timeout: 2_000 }).catch(() => false);
    if (isLoginVisible) {
      console.log('MJP setup: login screen is visible; logging in from a clean state');
      await this.ensureLoggedIn(defaultTestUser.mobileNumber, defaultTestUser.password);
    } else {
      console.log('MJP setup: authenticated session detected; reusing it without a logout/relaunch cycle');
    }

    console.log('MJP setup: authenticated; checking current screen');
    try {
      await homePage.expectHomeScreen();
    } catch {
      const completedEndDay = new EndDayPage(this.screen);
      if (await this.screen.getByText(/Day Completed|Day completed/i).isVisible({ timeout: 1_000 }).catch(() => false)) {
        console.log('MJP setup: previous End Day completed; returning to Home');
        await completedEndDay.backToHome();
      } else {
        console.log('MJP setup: home is not visible; clearing any pending Start Day flow');
        await startDayPage.cancelIfVisible();
      }
      await homePage.expectHomeScreen();
    }

    // The Home action card (Start Day / Check out for the day) can take a moment to finish loading
    // after landing on Home; poll briefly for either state instead of deciding immediately, since a
    // single fast check can race ahead of the card mounting and wrongly conclude neither is present.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await homePage.isEndDayAvailable()) break;
      if (await this.screen.getByText(/Check in for the day|Start Day/i).isVisible({ timeout: 500 }).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    if (await homePage.isEndDayAvailable()) {
      console.log('Existing session is already checked in; opening MJP from the post-check-in home screen');
      await homePage.expectPostCheckInState();
      return { homePage, startDayPage };
    }

    console.log('Existing session is logged in but not checked in; completing Start Day before opening MJP');
    await startDayPage.cancelIfVisible();
    await homePage.expectHomeScreen();

    console.log('MJP setup: opening Start Day');
    await homePage.openStartDay();
    console.log('MJP setup: Start Day opened; checking location');
    await startDayPage.expectLocationPopulated();
    console.log('MJP setup: capturing odometer photo');
    await startDayPage.captureOdometerPhoto();
    console.log('MJP setup: entering odometer reading');
    await startDayPage.enterOdometerReading(defaultStartDayData.odometerReading);
    console.log('MJP setup: submitting Start Day details');
    await startDayPage.expectNextEnabled();
    await startDayPage.clickNext();
    await startDayPage.expectConfirmationDetails(defaultStartDayData.odometerReading);
    await startDayPage.confirmStartDay();
    await startDayPage.expectCaptureSuccess();
    console.log('MJP setup: Start Day completed; opening dashboard');
    await startDayPage.goToDashboard();
    await homePage.expectPostCheckInState();

    return { homePage, startDayPage };
  }

  private async tapOptionalPermission(promptText: string, timeout = 60_000): Promise<void> {
    const prompt = this.screen.getByText(promptText);
    try {
      await expect(prompt).toBeVisible({ timeout });
      await prompt.tap();
    } catch {
      // The prompt may already be granted or may not apply on this device.
    }
  }

  async expectPostLogin(): Promise<string> {
    const checkInText = this.screen.getByText('Mark attendance');
    await expect(checkInText).toBeVisible();
    return checkInText.getText();
  }

  async getUserName(): Promise<string> {
    const candidates = [
      this.screen.getByText(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/),
      this.screen.getByText(/Amit|User|Profile/i),
      this.screen.getByText('Profile'),
    ];

    for (const candidate of candidates) {
      try {
        if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
          const value = await candidate.getText();
          const trimmed = value.trim();
          if (trimmed.length > 0 && !/^Profile$/i.test(trimmed)) return trimmed;
        }
      } catch {
        // Some builds surface the profile label differently, so we keep scanning visible text.
      }
    }

    throw new Error('User name was not found on the authenticated home screen.');
  }
}