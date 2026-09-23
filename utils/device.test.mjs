import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDeviceSerial } from './device.js';

test('pickDeviceSerial prefers a non-emulator device and falls back to emulator', () => {
  assert.equal(
    pickDeviceSerial('List of devices attached\n0123456789ABCDEF\tdevice\n emulator-5554\tdevice\n'),
    '0123456789ABCDEF',
  );

  assert.equal(
    pickDeviceSerial('List of devices attached\n emulator-5554\tdevice\n'),
    'emulator-5554',
  );
});
