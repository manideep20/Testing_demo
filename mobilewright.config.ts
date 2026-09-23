import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'mobilewright';

type DeviceInfo = {
  deviceType: 'real' | 'emulator';
  deviceId?: string;
};

function getDeviceInfo(): DeviceInfo {
  const adbPath = resolve(
    process.env.LOCALAPPDATA || '',
    'Android',
    'Sdk',
    'platform-tools',
    'adb.exe',
  );

  const result = spawnSync(adbPath, ['devices'], {
    encoding: 'utf8',
  });

  const devices = (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\sdevice\b/i.test(line))
    .map((line) => line.split(/\s+/)[0]);

  const emulator = devices.find((device) => device.startsWith('emulator-'));
  if (emulator) {
    return {
      deviceType: 'emulator',
      deviceId: getEmulatorName(emulator),
    };
  }

  const real = devices.find((device) => !device.startsWith('emulator-'));
  if (real) {
    return {
      deviceType: 'real',
      deviceId: real,
    };
  }

  return {
    deviceType: 'emulator',
  };
}

function getEmulatorName(serial: string): string | undefined {
  const adbPath = resolve(
    process.env.LOCALAPPDATA || '',
    'Android',
    'Sdk',
    'platform-tools',
    'adb.exe',
  );
  const result = spawnSync(adbPath, ['-s', serial, 'emu', 'avd', 'name'], {
    encoding: 'utf8',
  });
  const name = (result.stdout || '').trim().split(/\r?\n/)[0];
  return name || undefined;
}

const device = getDeviceInfo();
const useMockableEmulator = process.env.MOBILEWRIGHT_DEVICE === 'emulator';
const selectedDevice = useMockableEmulator
  ? { deviceType: 'emulator' as const, deviceId: process.env.MOBILEWRIGHT_AVD ?? 'Pixel_10a' }
  : device;

console.log(`Using ${selectedDevice.deviceType}${selectedDevice.deviceId ? ` (${selectedDevice.deviceId})` : ''}`);

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/*.spec.ts'],
  testIgnore: ['**/node_modules/**', '**/allure-results/**', '**/allure-report/**', '**/playwright-report/**'],
  platform: 'android',
  deviceType: selectedDevice.deviceType,
  deviceId: selectedDevice.deviceId,
  bundleId: 'com.peakline.sfa',
  installApps: resolve(process.cwd(), 'apps', 'app.apk'),
  autoAppLaunch: false,
  use: {
    animations: 'off',
    actionTimeout: 10_000,
    appLaunchTimeout: 30_000,
  },
  workers: 1,
  retries: 0,
  // Real-device flows can include login, Start Day recovery, camera capture, and the test itself.
  // Keep the session alive through those prerequisites instead of terminating it while the final
  // assertion is running and cascading "No active session" failures into the following tests.
  timeout: 300_000,
  outputDir: 'test-results',
  expect: {
    timeout: 30_000,
  },
  reporter: [
    ['line'],
    ['allure-playwright', { outputFolder: 'allure-results' }],
  ],
});
