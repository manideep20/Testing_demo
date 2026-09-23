import type { Screen } from '@mobilewright/core';
import { expect } from '@mobilewright/test';
import { tapCameraShutterButton } from './camera.page.js';

export async function captureVisitPhoto(screen: Screen): Promise<void> {
  const capture = screen.getByText('Capture', { exact: true })
    .or(screen.getByLabel('Capture'))
    .or(screen.getByRole('button', { name: /^Capture$/i }));

  if (await capture.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await expect(capture).toBeEnabled({ timeout: 5_000 });
    await capture.tap();
  } else {
    // No accessible "Capture" control was exposed (e.g. a plain drawn shutter circle); fall back to
    // the same screen-bounds-derived tap used for the Start/End Day odometer camera, instead of a
    // hardcoded pixel pair.
    await tapCameraShutterButton(screen);
  }

  const capturedState = screen.getByText(/Captured|Retake|Continue|Photo captured/i)
    .or(screen.getByLabel('Captured'))
    .or(screen.getByLabel('Continue'));
  if (!(await capturedState.isVisible({ timeout: 15_000 }).catch(() => false))) {
    console.log('Visit Flow: camera returned without an exposed captured-state label; continuing to the app Continue control');
  }
}
