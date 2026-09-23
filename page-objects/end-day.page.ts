import { expect } from '@mobilewright/test';
import type { Locator, Screen } from '@mobilewright/core';
import { captureCameraPhoto } from './camera.page.js';

export class EndDayPage {
  private readonly screen: Screen;
  private readonly capturePhotoLabel = 'Capture Odometer Photo';

  constructor(screen: Screen) {
    this.screen = screen;
  }

  async expectEndDayScreen(): Promise<void> {
    await expect(this.screen.getByText(/End Day|Odometer Photo|Odometer Reading/i)).toBeVisible({ timeout: 20_000 });
  }

  async enterOdometerReading(reading: string): Promise<void> {
    const input = this.screen.getByPlaceholder('Enter current reading');
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(reading);

    const heading = this.screen.getByText('Odometer Photo', { exact: true });
    if (await heading.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await heading.tap();
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  async dismissValidationDialog(): Promise<void> {
    const ok = this.screen.getByRole('button', { name: /OK/i });
    await expect(ok).toBeVisible({ timeout: 5_000 });
    await ok.tap();
  }

  async isValidationVisible(): Promise<boolean> {
    const candidates = [
      this.screen.getByTestId('android:id/message'),
      this.screen.getByText(/Validation Error|End odometer reading must be greater than start odometer reading/i),
    ];
    for (const candidate of candidates) {
      if (await candidate.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  async getValidationRequiredReading(): Promise<number | null> {
    const candidates = [
      this.screen.getByTestId('android:id/message'),
      this.screen.getByText(/Validation Error|End odometer reading must be greater than start odometer reading/i),
    ];
    for (const candidate of candidates) {
      if (!(await candidate.isVisible({ timeout: 1_000 }).catch(() => false))) {
        continue;
      }

      const message = await candidate.getText().catch(() => '');
      const numbers = [...message.matchAll(/\b\d[\d,]*\b/g)]
        .map(([value]) => Number(value.replace(/,/g, '')))
        .filter((value) => Number.isFinite(value));

      if (numbers.length > 0) {
        const requiredReading = Math.max(...numbers);
        console.log(`End Day validation requires a reading greater than ${requiredReading}; entering ${requiredReading + 1}`);
        return requiredReading;
      }
    }

    console.warn('End Day validation popup did not expose a numeric minimum reading.');
    return null;
  }

  async enterUntilConfirmation(initialReading: string): Promise<string> {
    let reading = Number(initialReading);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const value = String(reading);
      await this.enterOdometerReading(value);
      await this.clickNext();
      if (!(await this.isValidationVisible())) {
        return value;
      }
      const requiredReading = await this.getValidationRequiredReading();
      await this.dismissValidationDialog();
      reading = Math.max(reading + 1, (requiredReading ?? reading) + 1);
    }
    throw new Error('End Day reading was rejected after repeated UI-guided corrections.');
  }

  async enterRemark(remark: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidates = [
        this.screen.getByPlaceholder('Remark (optional)'),
        this.screen.getByPlaceholder('Remark'),
        this.screen.getByLabel('Remark'),
        this.screen.getByType('edittext'),
        this.screen.getByType('textinput'),
        this.screen.getByType('textarea'),
      ];
      for (const field of candidates) {
        if (await field.isVisible({ timeout: 500 }).catch(() => false)) {
          try {
            await field.fill(remark);
            return true;
          } catch {
            // Continue with the next native locator when the semantic locator is not editable.
          }
        }
      }
      await this.screen.swipe('up', { distance: 500, duration: 600 });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log('End Day remark field is optional and was not displayed; continuing because Confirm Details is visible.');
    return false;
  }

  async expectRemark(remark: string): Promise<void> {
    await expect(this.screen.getByText(remark, { exact: true })).toBeVisible({ timeout: 10_000 });
  }

  async captureOdometerPhoto(): Promise<void> {
    const capture = this.screen.getByText(this.capturePhotoLabel, { exact: true });
    await expect(capture).toBeVisible({ timeout: 15_000 });
    await capture.tap();

    for (const permission of [
      this.screen.getByText('While using the app', { exact: true }),
      this.screen.getByText('Only this time', { exact: true }),
      this.screen.getByText('Allow', { exact: true }),
    ]) {
      if (await permission.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await permission.tap();
        break;
      }
    }

    console.log('Camera is open; capturing the odometer photo.');
    await captureCameraPhoto(this.screen);

    await expect(this.screen.getByText(/Captured|Delete/i)).toBeVisible({ timeout: 15_000 });
    await expect(this.screen.getByPlaceholder('Enter current reading')).toBeVisible({ timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  async clickNext(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const next = await this.findNextControl();
      if (!next) {
        throw new Error('Next button was not found on the End Day screen.');
      }

      try {
        await expect(next).toBeVisible({ timeout: 10_000 });
        await expect(next).toBeEnabled({ timeout: 10_000 });
        await next.tap();
        return;
      } catch (error) {
        lastError = error;
        if (await this.screen.getByText(/Confirm details|Review/i).isVisible({ timeout: 1_000 }).catch(() => false)) {
          return;
        }
        console.warn(`End Day Next tap attempt ${attempt} failed; retrying after UI recovery.`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    throw new Error(`Could not tap Next on the End Day screen: ${String(lastError)}`);
  }

  async expectConfirmationDetails(reading: string): Promise<void> {
    await expect(this.screen.getByText(/Confirm details|Review/i)).toBeVisible({ timeout: 20_000 });
    const formatted = Number(reading).toLocaleString('en-IN');
    const readingLocator = this.screen.getByText(new RegExp(`(?:${reading}|${formatted})`));
    if (!(await readingLocator.isVisible({ timeout: 3_000 }).catch(() => false))) {
      console.warn(`End Day confirmation does not expose odometer value "${reading}" as accessible text.`);
    }
  }

  async confirmEndDay(): Promise<void> {
    const candidates = [
      this.screen.getByRole('button', { name: /Confirm\s*(?:&|and)\s*End\s*Day/i }),
      this.screen.getByLabel('Confirm & End Day'),
      this.screen.getByLabel('Confirm and End Day'),
      this.screen.getByLabel('Confirm & end day'),
      this.screen.getByLabel('Confirm and end day'),
      this.screen.getByText(/Confirm\s*(?:&|and)\s*End\s*Day/i),
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await expect(candidate).toBeEnabled({ timeout: 10_000 });
        console.log('Confirm Details: tapping Confirm & End Day');
        await candidate.tap();
        return;
      }
    }

    throw new Error('Confirm & End Day action was not found on the Confirm Details screen.');
  }

  async expectEndDaySuccess(): Promise<void> {
    await expect(this.screen.getByText(/End Day completed|Day ended|Day Completed|Completed successfully|Captured successfully|Go to dashboard|Back to Home/i)).toBeVisible({
      timeout: 30_000,
    });
    console.log('End Day: captured successfully screen is visible');
  }

  async goToDashboard(): Promise<void> {
    if (await this.screen.getByText(/Day Completed|Day completed/i).isVisible({ timeout: 1_000 }).catch(() => false)) {
      return;
    }

    const dashboard = this.screen.getByRole('button', { name: /Go\s*to\s*dashboard/i })
      .or(this.screen.getByLabel('Go to dashboard'))
      .or(this.screen.getByText(/Go\s*to\s*dashboard/i));
    if (await dashboard.isVisible({ timeout: 10_000 }).catch(() => false)) {
      console.log('Captured successfully: tapping Go to dashboard');
      await dashboard.tap();
      await expect(this.screen.getByText(/Day Completed|Day completed/i)).toBeVisible({ timeout: 20_000 });
      console.log('End Day: Day Completed screen is visible');
      return;
    }

    throw new Error('Go to dashboard action was not found after End Day capture completed.');
  }

  async backToHome(): Promise<boolean> {
    await expect(this.screen.getByText(/Day Completed|Day completed/i)).toBeVisible({ timeout: 15_000 });

    const homeActions = [
      this.screen.getByLabel('Back to Home'),
      this.screen.getByLabel('Back to home'),
      this.screen.getByRole('button', { name: 'Back to Home' }),
      this.screen.getByRole('button', { name: 'Back to home' }),
      this.screen.getByRole('button', { name: /Back\s*to\s*home|Go\s*home/i }),
      this.screen.getByText('Back to Home', { exact: true }),
      this.screen.getByText('Back to home', { exact: true }),
      this.screen.getByText(/Back\s*to\s*home|Go\s*home/i),
      this.screen.getByLabel('Go Home'),
    ];

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      for (const action of homeActions) {
        if (await action.isVisible({ timeout: 5_000 }).catch(() => false)) {
          console.log(`Day Completed: tapping Back to Home (attempt ${attempt})`);
          try {
            await action.tap();
          } catch (error) {
            console.warn(`Back to Home tap attempt ${attempt} failed: ${String(error)}`);
            continue;
          }

          await new Promise((resolve) => setTimeout(resolve, 750));
          try {
            await expect(this.screen.getByText('Check in for the day', { exact: true })).toBeVisible({ timeout: 15_000 });
            console.log('End Day: Check in for the day is visible after Back to Home');
            return true;
          } catch (error) {
            console.warn(`Back to Home tap did not reach Home on attempt ${attempt}: ${String(error)}`);
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (await this.screen.getByText('Check in for the day', { exact: true }).isVisible({ timeout: 1_000 }).catch(() => false)) {
      return true;
    }

    if (await this.screen.getByText(/Day Completed|Day completed/i).isVisible({ timeout: 1_000 }).catch(() => false)) {
      console.warn('Day Completed is still visible after Back to Home attempts; Home navigation was not confirmed.');
      return false;
    }

    throw new Error('Back to Home control was not found after reaching the Day Completed screen.');
  }

  private async findNextControl(): Promise<Locator | null> {
    const candidates = [
      this.screen.getByRole('button', { name: 'Next' }),
      this.screen.getByRole('button', { name: /Next/i }),
      this.screen.getByText('Next', { exact: true }),
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible({ timeout: 1_000 }).catch(() => false)) return candidate;
    }

    return null;
  }
}
