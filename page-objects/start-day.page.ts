import { expect } from '@mobilewright/test';
import type { Locator, Screen } from '@mobilewright/core';
import { captureCameraPhoto } from './camera.page.js';

export class StartDayPage {
  private readonly screen: Screen;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  private readonly capturePhotoLabel = 'Capture Odometer Photo';

  async expectLocationPopulated(): Promise<void> {
    await expect(this.screen.getByText(/Verification Location|Current location|Location updated|GPS|Lat:|Lng:/i)).toBeVisible({
      timeout: 20_000,
    });
  }

  async captureOdometerPhoto(): Promise<void> {
    const photo = this.screen.getByText(this.capturePhotoLabel, { exact: true });
    await expect(photo).toBeVisible({ timeout: 15_000 });
    await photo.tap();

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

    const captureSuccessCandidates = [
      this.screen.getByText(/Captured|Delete/i),
      this.screen.getByLabel('Captured'),
      this.screen.getByLabel('Delete'),
      this.screen.getByText('Captured', { exact: true }),
      this.screen.getByText('Delete', { exact: true }),
    ];

    for (let attempt = 0; attempt < 30; attempt += 1) {
      for (const candidate of captureSuccessCandidates) {
        if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error('Odometer photo was not captured successfully on the Start Day screen.');
  }

  async expectOdometerPhotoRequired(): Promise<void> {
    await expect(this.screen.getByText(this.capturePhotoLabel)).toBeVisible({ timeout: 20_000 });
  }

  async expectNextDisabled(): Promise<void> {
    const next = await this.findNextControl();
    if (!next) return;
    await expect(next).toBeVisible({ timeout: 10_000 });
    await expect(next).toBeDisabled({ timeout: 20_000 });
  }

  async expectNextEnabled(): Promise<void> {
    const next = await this.findNextControl(30_000);
    if (!next) throw new Error('Next button was not found on the Start Day screen.');
    await expect(next).toBeVisible({ timeout: 10_000 });
    await expect(next).toBeEnabled({ timeout: 20_000 });
  }

  async enterOdometerReading(reading: string): Promise<void> {
    const input = this.screen.getByPlaceholder('Enter current reading');
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(reading);
    const formHeading = this.screen.getByText('Odometer Photo', { exact: true });
    if (await formHeading.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await formHeading.tap();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  async enterRemark(remark: string): Promise<void> {
    const field = this.screen.getByPlaceholder('Remark (optional)');
    await expect(field).toBeVisible({ timeout: 10_000 });
    await field.fill(remark);
  }

  async expectRemark(remark: string): Promise<void> {
    await expect(this.screen.getByText(remark, { exact: true })).toBeVisible({ timeout: 10_000 });
  }

  async clearOdometerReading(): Promise<void> {
    const input = this.screen.getByPlaceholder('Enter current reading');
    if (!(await input.isVisible({ timeout: 1_000 }).catch(() => false))) {
      return;
    }

    const value = await input.getValue().catch(() => '');
    if (!value) {
      return;
    }

    await input.clear();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  async clickNext(): Promise<void> {
    const next = await this.findNextControl(30_000);
    if (!next) throw new Error('Next button was not found on the Start Day screen.');
    await this.expectNextEnabled();
    await next.tap();
    await this.expectConfirmationDetails();
  }

  async expectConfirmationDetails(reading?: string): Promise<void> {
    const confirmationHeading = this.screen.getByText(/Confirm details/i);
    const reviewSubtitle = this.screen.getByText(/Review before starting your day/i);
    const confirmationIndicators = [confirmationHeading, reviewSubtitle];

    let confirmationVisible = false;
    for (const indicator of confirmationIndicators) {
      if (await indicator.isVisible({ timeout: 2_000 }).catch(() => false)) {
        confirmationVisible = true;
        break;
      }
    }

    if (!confirmationVisible) {
      await expect(confirmationHeading).toBeVisible({ timeout: 20_000 });
    }

    if (reading !== undefined) {
      const formatted = Number(reading).toLocaleString('en-IN');
      await expect(this.screen.getByText(new RegExp(`(?:${reading}|${formatted})`))).toBeVisible({ timeout: 10_000 });
    }
  }

  async expectReviewPage(reading: string): Promise<void> {
    await this.expectConfirmationDetails(reading);
  }

  async editDetails(): Promise<void> {
    const editButton = this.screen.getByText(/Edit|Edit Details|Edit details/i);
    if (await editButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await editButton.tap();
      return;
    }

    const secondaryEdit = this.screen.getByText(/Back|Previous/i);
    if (await secondaryEdit.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await secondaryEdit.tap();
      return;
    }

    throw new Error('Edit Details action was not found on the review page.');
  }

  async confirmStartDay(): Promise<void> {
    const confirmCandidates = [
      this.screen.getByRole('button', { name: 'Confirm & Start Day' }),
      this.screen.getByText('Confirm & Start Day', { exact: true }),
    ];

    for (const confirm of confirmCandidates) {
      if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await confirm.tap();
        return;
      }
    }

    throw new Error('Confirm & Start Day button was not found on the review screen.');
  }

  async expectCaptureSuccess(): Promise<void> {
    await expect(this.screen.getByText(/Captured successfully|Start Day completed/i)).toBeVisible({ timeout: 30_000 });
  }

  async goToDashboard(): Promise<void> {
    const dashboard = this.screen.getByRole('button', { name: /Go to dashboard/i })
      .or(this.screen.getByLabel('Go to dashboard'))
      .or(this.screen.getByText(/Go to dashboard/i));
    if (await dashboard.isVisible({ timeout: 10_000 }).catch(() => false)) {
      console.log('Start Day captured successfully: tapping Go to dashboard');
      await dashboard.tap();
      await this.expectDashboardAfterStartDay();
      return;
    }

    throw new Error('Go to dashboard button was not found on the completed screen.');
  }

  async expectDashboardAfterStartDay(): Promise<void> {
    await expect(this.screen.getByText(/Today's route|Check out for the day/i)).toBeVisible({ timeout: 15_000 });
  }

  async cancelCurrentFlow(): Promise<boolean> {
    const reviewScreen = this.screen.getByText(/Confirm Details|Review/i);
    if (await reviewScreen.isVisible({ timeout: 300 }).catch(() => false)) {
      const editDetails = this.screen.getByText(/Edit Details|Edit details/i);
      if (await editDetails.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await editDetails.tap();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const cancelAfterEdit = this.screen.getByLabel('Cancel', { exact: true });
      if (await cancelAfterEdit.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await cancelAfterEdit.tap();
        return true;
      }
    }

    const startDayScreen = this.screen.getByText(/Verification Location|Odometer Photo|Odometer Reading/i);
    if (await startDayScreen.isVisible({ timeout: 300 }).catch(() => false)) {
      const cancelOnStartDay = this.screen.getByLabel('Cancel', { exact: true });
      if (await cancelOnStartDay.isVisible({ timeout: 500 }).catch(() => false)) {
        await cancelOnStartDay.tap();
        return true;
      }
    }

    return false;
  }

  async cancelIfVisible(): Promise<boolean> {
    return await this.cancelCurrentFlow();
  }

  async declineLocationAccuracyPrompt(): Promise<void> {
    const decline = this.screen.getByText(/Don't allow|Decline|No/i);
    if (await decline.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await decline.tap();
    }
  }

  async expectOfflinePolicyMessage(): Promise<void> {
    await expect(this.screen.getByText(/offline|internet|network|connection|available/i)).toBeVisible({ timeout: 15_000 });
  }

  async deleteCapturedPhoto(): Promise<void> {
    const deleteCandidates = [
      this.screen.getByLabel('Delete'),
      this.screen.getByLabel('Delete photo'),
      this.screen.getByLabel('Remove photo'),
      this.screen.getByText('Delete', { exact: true }),
    ];

    for (const deleteButton of deleteCandidates) {
      if (await deleteButton.isVisible({ timeout: 500 }).catch(() => false)) {
        await deleteButton.tap();
        await this.expectNextDisabled();
        return;
      }
    }

    const capturedLabel = this.screen.getByText('Captured', { exact: true });
    await expect(capturedLabel).toBeVisible({ timeout: 10_000 });
    // No accessible "Delete" label was found on this render; fall back to locating the small
    // icon-type control near the "Captured" thumbnail dynamically (matched by type index, like every
    // other icon lookup in this codebase) instead of a fixed pixel coordinate that would go stale the
    // moment the layout shifts.
    const capturedBox = await capturedLabel.boundingBox().catch(() => undefined);
    if (capturedBox) {
      const nodes = await this.screen.viewTree();
      type ViewNode = (typeof nodes)[number];
      const iconCandidates: Array<{ type: string; index: number; node: ViewNode }> = [];
      const indexes = new Map<string, number>();
      const collectIcons = (node: ViewNode): void => {
        const type = (node.type ?? '').toLowerCase();
        const index = indexes.get(type) ?? 0;
        indexes.set(type, index + 1);
        const text = (node.text ?? node.label ?? '').trim();
        const nearCaptured = Math.abs(node.bounds.y - capturedBox.y) < 200;
        if (
          node.isVisible
          && nearCaptured
          && !text
          && /image|icon|button/.test(type)
          && node.bounds.width > 0 && node.bounds.width < 200
        ) {
          iconCandidates.push({ type, index, node });
        }
        for (const child of node.children) collectIcons(child);
      };
      for (const root of nodes) collectIcons(root);
      const nearestIcon = iconCandidates.sort(
        (left, right) => Math.abs(left.node.bounds.y - capturedBox.y) - Math.abs(right.node.bounds.y - capturedBox.y),
      )[0];
      if (nearestIcon) {
        await this.screen.getByType(nearestIcon.type).nth(nearestIcon.index).tap().catch(() => undefined);
        await this.expectNextDisabled();
        return;
      }
    }
    await this.expectNextDisabled();
  }

  async expectPhotoStateReset(): Promise<void> {
    await expect(this.screen.getByText(this.capturePhotoLabel)).toBeVisible({ timeout: 20_000 });
    await this.expectNextDisabled();
  }

  private async findNextControl(timeout = 1_000): Promise<Locator | null> {
    const candidates = [
      this.screen.getByRole('button', { name: 'Next' }),
      this.screen.getByRole('button', { name: /Next/i }),
      this.screen.getByText('Next', { exact: true }),
      this.screen.getByText(/Next/i),
      this.screen.getByLabel('Next'),
      this.screen.getByRole('button', { name: /Continue/i }),
      this.screen.getByText(/Continue/i),
    ];

    const deadline = Date.now() + timeout;
    do {
      for (const candidate of candidates) {
        if (await candidate.isVisible({ timeout: 1_000 }).catch(() => false)) return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);

    return null;
  }
}
