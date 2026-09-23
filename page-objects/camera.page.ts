import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Screen } from '@mobilewright/core';

const adbPath = resolve(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');

// Cached after the first lookup: the physical screen size does not change during a test run, and
// querying it via "adb shell wm size" is near-instant, unlike a full accessibility view-tree scan.
let cachedScreenSize: { width: number; height: number } | undefined;

function getDeviceScreenSize(): { width: number; height: number } {
  if (cachedScreenSize) {
    return cachedScreenSize;
  }
  const output = execFileSync(adbPath, ['shell', 'wm', 'size'], { encoding: 'utf8' });
  // Prefer "Override size" (what apps actually render at) when present, otherwise "Physical size".
  const match = output.match(/Override size:\s*(\d+)x(\d+)/) ?? output.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) {
    throw new Error(`Unable to parse device screen size from "adb shell wm size" output: ${output}`);
  }
  cachedScreenSize = { width: Number(match[1]), height: Number(match[2]) };
  return cachedScreenSize;
}

// The in-app camera's shutter control is a plain drawn circle with no resource-id, text, or
// content-desc, so it cannot be resolved through the Locator API (getByText/getByLabel/getByRole all
// require an accessible attribute). A full screen.viewTree() accessibility scan to derive its bounds
// was tried and reverted: it added enough latency before the tap that the camera view could close/time
// out first. Instead, derive the tap position from the device's actual live screen size (queried via
// adb, cached, near-instant) rather than either a raw hardcoded pixel pair or a slow view-tree scan.
export async function tapCameraShutterButton(screen: Screen): Promise<void> {
  const { width, height } = getDeviceScreenSize();
  const x = width / 2;
  const y = height * 0.89;
  await screen.tap(x, y);
}

export async function captureCameraPhoto(screen: Screen): Promise<void> {
  await tapCameraShutterButton(screen);

  // Give the camera a moment to capture/process the photo
  await new Promise((resolve) => setTimeout(resolve, 1000));
}