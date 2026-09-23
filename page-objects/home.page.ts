import { expect } from '@mobilewright/test';
import type { Locator, Screen } from '@mobilewright/core';
import { tapAppHomeTab } from './login.page.js';

export class HomePage {
  private readonly screen: Screen;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  async expectHomeScreen(timeoutMs = 15_000): Promise<void> {
    const indicators = [
      this.screen.getByText('Mark attendance', { exact: true }),
      this.screen.getByText('Check in for the day', { exact: true }),
      this.screen.getByText("Today's route", { exact: true }),
      this.screen.getByText('Mark attendance', { exact: true }),
      this.screen.getByText('Check out for the day', { exact: true }),
      this.screen.getByText('Profile', { exact: true }),
      this.screen.getByLabel('Check in for the day'),
      this.screen.getByLabel("Today's route"),
      this.screen.getByLabel('Check out for the day'),
      this.screen.getByLabel('Profile'),
    ];

    let homeScreen = indicators[0];
    for (const indicator of indicators.slice(1)) {
      homeScreen = homeScreen.or(indicator);
    }

    await homeScreen.waitFor({ state: 'visible', timeout: timeoutMs });
  }

  async expectPostCheckInState(): Promise<void> {
    await this.expectHomeScreen();
    const checkoutIndicators = [
      this.screen.getByText('Check out for the day', { exact: true }),
      this.screen.getByLabel('Check out for the day'),
      this.screen.getByRole('button', { name: 'Check out for the day' }),
    ];

    for (const indicator of checkoutIndicators) {
      if (await indicator.isVisible({ timeout: 5_000 }).catch(() => false)) {
        return;
      }
    }

    throw new Error('Post-check-in Home state was not visible: Check out for the day is unavailable.');
  }

  async returnHome(): Promise<void> {
    // "Home" is ambiguous on this app: the Android OS system navigation bar also exposes a button
    // labeled "Home" (which backgrounds the whole app to the launcher instead of switching tabs).
    // Use the system-UI-excluding tap helper so this always hits the app's own bottom-nav Home tab.
    if (await tapAppHomeTab(this.screen)) {
      await this.expectHomeScreen();
      return;
    }

    await this.expectHomeScreen();
  }

  // Like a real user, if the action isn't visible yet, try scrolling a little (up first, since a
  // banner/announcement can push the action below the fold; then down, in case it was scrolled past)
  // before giving up, instead of assuming the action doesn't exist.
  private async findAmongScrolling(candidates: Locator[], attempts = 6): Promise<Locator | null> {
    for (const candidate of candidates) {
      if (await candidate.isVisible({ timeout: 1_500 }).catch(() => false)) {
        return candidate;
      }
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const direction = attempt % 2 === 0 ? 'up' : 'down';
      await this.screen.swipe(direction, { distance: 350, duration: 500 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
      for (const candidate of candidates) {
        if (await candidate.isVisible({ timeout: 1_000 }).catch(() => false)) {
          return candidate;
        }
      }
    }

    return null;
  }

  async openStartDay(): Promise<void> {
    const startCandidates = [
      this.screen.getByLabel('Check in for the day'),
      this.screen.getByText('Check in for the day', { exact: true }),
      this.screen.getByText(/Check in for the day/i),
      this.screen.getByLabel('Start Day'),
      this.screen.getByText('Start Day', { exact: true }),
      this.screen.getByText(/Start Day/i),
    ];

    let start = await this.findAmongScrolling(startCandidates);

    if (!start) {
      await this.expectHomeScreen();
      start = await this.findAmongScrolling(startCandidates);
    }

    if (!start) {
      throw new Error('Start Day action was not visible on the home screen.');
    }

    await start.tap();
    await expect(this.screen.getByText(/Verification Location|Odometer Photo|Odometer Reading/i)).toBeVisible({
      timeout: 20_000,
    });
  }

  async openEndDay(): Promise<void> {
    const checkoutCandidates = [
      this.screen.getByLabel('Check out for the day'),
      this.screen.getByRole('button', { name: 'Check out for the day' }),
      this.screen.getByText('Check out for the day', { exact: true }),
      this.screen.getByText(/Check out for the day/i),
    ];

    const checkout = await this.findAmongScrolling(checkoutCandidates);
    if (!checkout) {
      throw new Error('Check out for the day action was not visible on the home screen.');
    }
    // The control can render before it finishes loading (e.g. while location/status data is still
    // being fetched); wait for it to become enabled instead of tapping immediately and failing.
    await expect(checkout).toBeEnabled({ timeout: 15_000 });
    await checkout.tap();

    const endDayPopupActions = [
      this.screen.getByRole('button', { name: 'End Day' }),
      this.screen.getByRole('button', { name: /END DAY/i }),
      this.screen.getByText('End Day', { exact: true }),
      this.screen.getByText('END DAY', { exact: true }),
      this.screen.getByRole('button', { name: 'OK' }),
      this.screen.getByText('OK', { exact: true }),
      this.screen.getByRole('button', { name: 'YES' }),
      this.screen.getByText('YES', { exact: true }),
      this.screen.getByRole('button', { name: 'CONFIRM' }),
      this.screen.getByText('CONFIRM', { exact: true }),
      this.screen.getByRole('button', { name: /Confirm|Yes|Checkout|Check out/i }),
      this.screen.getByText(/Confirm|Yes|Checkout|Check out/i),
      this.screen.getByRole('button', { name: /Continue|Proceed|Start End Day/i }),
      this.screen.getByText(/Continue|Proceed|Start End Day/i),
    ];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      for (const action of endDayPopupActions) {
        if (await action.isVisible({ timeout: 500 }).catch(() => false)) {
          await action.tap();
          break;
        }
      }

      const endDayScreen = this.screen.getByText(/Odometer Photo|Odometer Reading|Enter current reading|Capture Odometer Photo/i);
      if (
        await endDayScreen.isVisible({ timeout: 500 }).catch(() => false)
      ) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error('End Day popup or screen did not appear after tapping Check out for the day.');
  }

  async isEndDayAvailable(): Promise<boolean> {
    const checkoutCandidates = [
      this.screen.getByLabel('Check out for the day'),
      this.screen.getByRole('button', { name: 'Check out for the day' }),
      this.screen.getByText('Check out for the day', { exact: true }),
    ];

    return (await this.findAmongScrolling(checkoutCandidates, 3)) !== null;
  }

  async expectEndDayAvailable(): Promise<void> {
    await expect(this.screen.getByText('Check out for the day', { exact: true })).toBeVisible({ timeout: 15_000 });
  }
}
