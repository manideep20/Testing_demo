import { expect, test } from '@mobilewright/test';
import type { Screen } from '@mobilewright/core';
import { readFileSync } from 'node:fs';
import { AppState, clearDeviceLocation, ensureAppPrecondition, ensureAppPreconditionWithRecovery, LoginPage } from '../page-objects/login.page.js';
import { VisitPage } from '../page-objects/visit.page.js';
import { defaultTestUser } from '../test-data/test-config.js';
import { annotatePriority } from './test-priority.js';

const mobileTestCases = JSON.parse(
  readFileSync(new URL('../test-data/mobile-test-cases.json', import.meta.url), 'utf-8')
) as { testCases: Array<{ id: string; testData: Record<string, unknown> }> };

function getCaseData(id: string): Record<string, unknown> {
  const testCase = mobileTestCases.testCases.find((entry) => entry.id === id);
  if (!testCase) throw new Error(`Missing mobile test case definition for ${id}`);
  return testCase.testData;
}

const ensureVisitReady = async (screen: Screen) => {
  const state = await ensureAppPrecondition(screen, AppState.POST_CHECKIN_HOME);
  if (state !== AppState.POST_CHECKIN_HOME) {
    throw new Error(`Visit Flow precondition failed; expected POST_CHECKIN_HOME but detected ${state}.`);
  }
  // Confirm we're actually on the checked-in Home dashboard rather than depending on any single nav
  // label (e.g. "MJP"/"PJP"), whose visibility can vary with scroll position between test runs.
  const homeIndicator = screen.getByText('Check out for the day', { exact: true })
    .or(screen.getByText(/Track Approvals|Awaiting Sync|Missed Outlets|Day Summary/i))
    .or(screen.getByText('MJP', { exact: true }))
    .or(screen.getByText('PJP', { exact: true }));
  await homeIndicator.waitFor({ state: 'visible', timeout: 15_000 });
};

const openOutletAtItsSavedLocation = async (screen: Screen, visitPage = new VisitPage(screen)): Promise<VisitPage> => {
  const outlet = await visitPage.openAnyOutletFromList(undefined, false, true);
  if (!outlet) {
    throw new Error('No Start Visit eligible outlet was available for this visit-flow assertion.');
  }
  await visitPage.logLocationUi('before location refresh');
  await visitPage.ensureGeofenceState(outlet, 'inside');
  await expect(screen.getByText(/Outlet Details|Outlet Summary/i)).toBeVisible({ timeout: 10_000 });
  await visitPage.logLocationUi('after desired-state refresh');
  return visitPage;
};

const openConfiguredNumericTask = async (visitPage: VisitPage, caseId: string): Promise<void> => {
  const configuredTasks = await visitPage.getConfiguredVisitTaskNames();
  const supportedTasks = getCaseData(caseId).tasks as string[];
  const task = supportedTasks.find((candidate) => configuredTasks.includes(candidate));
  if (!task) {
    throw new Error(
      `${caseId} requires one of the configured numeric tasks (${supportedTasks.join(', ')}), `
      + `but this outlet exposes: ${configuredTasks.join(', ') || 'none'}.`,
    );
  }
  await visitPage.startVisitTask(task);
};

// Keep failure evidence without paying the device-recording/storage cost for every passing test.
test.use({ video: 'retain-on-failure' });

test.beforeAll(async ({ screen }) => {
  // A user switch (via MOBILE_TEST_USER) requires logging in and completing Start Day once, which can
  // exceed a single test's timeout. Extend this one-time setup hook so it isn't cut short mid-flow.
  test.setTimeout(10 * 60 * 1000);
  const loginPage = new LoginPage(screen);
  await loginPage.ensureAppVisible();
  await loginPage.dismissExitPromptIfVisible();
  // ensureLoggedIn is idempotent (skips the logout/login cycle if the configured user is already the
  // active session), so always call it -- this is what makes switching defaultTestUser in
  // test-config.ts (e.g. to a user whose outlets aren't already fully visited) actually take effect
  // without requiring the MOBILE_TEST_USER env var to be set at runtime.
  await loginPage.ensureLoggedIn(defaultTestUser.mobileNumber, defaultTestUser.password);
  // Complete Start Day once here (if needed) so every test's beforeEach starts from POST_CHECKIN_HOME quickly.
  const state = await ensureAppPrecondition(screen, AppState.POST_CHECKIN_HOME);
  if (state !== AppState.POST_CHECKIN_HOME) {
    throw new Error(`Visit Flow one-time setup ended in ${state}, expected POST_CHECKIN_HOME.`);
  }
  await new VisitPage(screen).endAnyActiveVisit();
});

test.beforeEach(async ({ screen }, testInfo) => {
  annotatePriority(testInfo);
  // The previous test's afterEach always force-closes the app, so every test starts from a clean,
  // fully-closed process (like a real user opening the app fresh) instead of chaining through
  // whatever screen the last test happened to leave open.
  const preCondition = await ensureAppPreconditionWithRecovery(
    screen,
    AppState.POST_CHECKIN_HOME,
    'Visit Flow setup',
  );
  if (preCondition !== AppState.POST_CHECKIN_HOME) {
    throw new Error(`Visit Flow setup ended in ${preCondition}, expected POST_CHECKIN_HOME.`);
  }
  await new VisitPage(screen).endAnyActiveVisit();
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
      console.log('Could not capture failure screenshot');
    }
  }

  try {
    clearDeviceLocation();
  } catch (error) {
    console.log(`Visit Flow location cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // An active visit blocks "Check out for the day" and turns the next test's "Start Visit" into
  // "Resume", so end it before force-closing rather than leaking it into the following test.
  try {
    await new VisitPage(screen).endAnyActiveVisit();
  } catch (error) {
    console.log(`Visit Flow active-visit cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Force-close is the sole, deterministic cleanup/handover step: it hands the next test a fully
  // closed app instead of chaining through in-app navigation (BACK presses / Exit App prompts),
  // which was slow and the source of repeated Exit App popups between tests.
  try {
    await loginPage.forceCloseApp();
  } catch (error) {
    console.log(`Visit Flow app cleanup (force-close) failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

test('TC-033 - Start Visit is disabled outside the 100m geofence', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  const outlet = await visitPage.openAnyOutletFromList(undefined, false, true);
  if (!outlet) throw new Error('TC-033 requires a Start Visit eligible outlet, but none was available.');
  await visitPage.ensureGeofenceDistance(outlet, getCaseData('TC-033').distanceMeters as number);
  const distanceMessage = screen.getByText(/You are\s+[\d,.]+\s*(?:m|km)\s+away|Move within 100m|outside the geofence|farther than 100m/i);
  await expect(distanceMessage).toBeVisible({ timeout: 10_000 });
  console.log(`TC-033: selected outlet "${outlet}"; distance warning: ${await distanceMessage.getText().catch(() => 'visible')}`);
  await visitPage.expectStartVisitDisabledBelowDistanceWarning();
});

test('TC-034 - Start Visit is enabled within the 100m geofence', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = await openOutletAtItsSavedLocation(screen);
  const outlet = visitPage.getActiveOutletName();
  await visitPage.setGeofenceDistance(outlet, getCaseData('TC-034').distanceMeters as number);
  await visitPage.expectInRangeLocationStatus();
  await visitPage.expectStartVisitEnabled(true);
});

test('TC-035 - Geofence boundary follows the 100m threshold', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = await openOutletAtItsSavedLocation(screen);
  const distances = getCaseData('TC-035').distancesMeters as number[];
  const outlet = visitPage.getActiveOutletName();
  for (const distance of distances) {
    await visitPage.setGeofenceDistance(outlet, distance);
    await visitPage.expectGeofenceBoundaryStatus(distance);
  }
});

// Skipped: no outlet with a pending location-correction request is reliably available in the live
// test data on demand, so this cannot be exercised deterministically without hardcoding an outlet.
test.skip('TC-036 - A single visit can be started while a location correction request is pending approval', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  const outlet = await visitPage.openAnyOutletFromList(
    /Location update is pending approval|pending location update|another request cannot be raised until it is approved|start visit is disabled until approval/i,
    true,
  );
  if (!outlet) return console.log('No Start Visit eligible outlets found for pending-location test.');
  console.log(`TC-036: selected already-pending outlet "${outlet}"`);
  await visitPage.expectLocationCorrectionPending();
  await visitPage.expectStartVisitEnabled(true);
  await visitPage.tapStartVisitAndVerify();
});

test('TC-038 - Mark as Closed is actionable only within the outlet geofence', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  const distances = getCaseData('TC-038').distancesMeters as number[];
  console.log(`TC-038: configured outside/inside distance examples ${distances.join(', ')}m; using the live outlet coordinates.`);
  const outlet = await visitPage.openAnyOutletFromList(undefined, false, true);
  if (!outlet) throw new Error('TC-038 requires a Start Visit eligible outlet, but none was available.');
  await visitPage.setGeofenceDistance(outlet, distances[0]);
  await visitPage.expectMarkAsClosedEnabled(false);
  await visitPage.setGeofenceDistance(outlet, distances[1]);
  await visitPage.expectMarkAsClosedEnabled(true);
});

test('TC-039 - Starting a new visit is blocked after an outlet closure request is submitted', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = await openOutletAtItsSavedLocation(screen);
  const outlet = visitPage.getActiveOutletName();
  await visitPage.submitClosureRequest();
  await visitPage.reopenOutletAndVerifyClosurePending(outlet);
  await openPendingApprovalRequest(
    screen,
    getCaseData('TC-044-CANCEL-CLOSURE').approvalType as string,
    outlet,
  );
});

test('TC-040 - Visit tasks match outlet configuration', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  const taskNames = await visitPage.getConfiguredVisitTaskNames();
  const tally = await visitPage.getCompletedTaskTally();
  expect(tally).not.toBeNull();
  expect(taskNames.length).toBeGreaterThan(0);
  expect(taskNames).toHaveLength(tally!.total);
  console.log(`TC-040: configured tasks (${tally!.total}): ${taskNames.join(', ')}.`);
});

test('TC-041 - Stock and facing fields accept zero', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  await openConfiguredNumericTask(visitPage, 'TC-041');
  const value = (getCaseData('TC-041').fieldValues as number[])[0];
  await visitPage.enterNumericValue(value);
  await visitPage.expectNumericValue(value);
});

test('TC-042 - Stock and facing fields accept 9999', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  await openConfiguredNumericTask(visitPage, 'TC-042');
  const value = (getCaseData('TC-042').fieldValues as number[])[0];
  await visitPage.enterNumericValue(value);
  await visitPage.expectNumericValue(value);
});

test('TC-043 - Stock and facing fields reject values above 9999', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  await openConfiguredNumericTask(visitPage, 'TC-043');
  const value = (getCaseData('TC-043').fieldValues as number[])[0];
  await visitPage.enterNumericValue(value);
  await visitPage.expectNumericValueRejected(value);
});

test('TC-044 - Stock and facing fields reject values below zero', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  await openConfiguredNumericTask(visitPage, 'TC-044');
  const value = (getCaseData('TC-044').fieldValues as number[])[0];
  await visitPage.enterNumericValue(value);
  await visitPage.expectNumericValueRejected(value);
});

test('TC-052 - Ending a visit triggers an awaiting sync notification', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  await visitPage.endVisit();
  await visitPage.continueJourneyAfterEndVisit();
});

test('TC-053 - CSM Gift Distribution screen supports allocated gift distribution', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  await visitPage.openGiftDistribution();
  await visitPage.expectGiftDistribution();
});

test('TC-054 - CSM Gift Distribution shows required recipient fields and optional PAN', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  await visitPage.openGiftDistribution();
  await visitPage.expectGiftRecipientFieldRequirements();
});

test('TC-055 - Report Issue opens generic Help & Support contact card', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  await visitPage.openReportIssue();
  await visitPage.expectHelpAndSupport();
});

const openPendingApprovalRequest = async (
  screen: Screen,
  requestType: string,
  outlet: string,
): Promise<void> => {
  await new LoginPage(screen).recoverToHome();
  const candidates = [
    screen.getByText('Track Approvals', { exact: false }),
    screen.getByLabel('Track Approvals', { exact: false }),
    screen.getByText('Approvals', { exact: false }),
    screen.getByLabel('Approvals', { exact: false }),
    screen.getByText('Notifications', { exact: false }),
    screen.getByLabel('Notifications', { exact: false }),
  ];
  let opened = false;
  for (const candidate of candidates) {
    if (await candidate.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await candidate.tap();
      opened = true;
      break;
    }
  }
  if (!opened) {
    throw new Error('Track Approvals navigation was not visible on the current Home screen.');
  }

  // Filter to the Pending tab (Approvals screen has All | Pending | Approved | Rejected | Cancelled
  // tabs) so a since-actioned duplicate elsewhere in the list doesn't hide the item we need to cancel.
  const pendingTab = screen.getByText('Pending', { exact: true });
  if (await pendingTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await pendingTab.tap();
  }

  const request = screen.getByText(requestType, { exact: false });
  const outletName = screen.getByText(outlet, { exact: true });
  await request.scrollIntoViewIfNeeded({ maxSwipes: 8 });
  await expect(request).toBeVisible({ timeout: 15_000 });
  await outletName.scrollIntoViewIfNeeded({ maxSwipes: 8 });
  await expect(outletName).toBeVisible({ timeout: 15_000 });

  const findRequestRow = async (): Promise<{
    outletNode: { bounds: { x: number; y: number; width: number; height: number } };
    requestNode: { bounds: { x: number; y: number; width: number; height: number } };
    cancelNode: { bounds: { x: number; y: number; width: number; height: number } };
  } | null> => {
    const tree = await screen.viewTree();
    type ViewNode = (typeof tree)[number];
    const outletNodes: ViewNode[] = [];
    const requestNodes: ViewNode[] = [];
    const cancelNodes: ViewNode[] = [];
    const collect = (node: ViewNode): void => {
      const value = (node.text ?? node.label ?? '').trim();
      if (node.isVisible && value === outlet) outletNodes.push(node);
      if (node.isVisible && value.toLowerCase().includes(requestType.toLowerCase())) requestNodes.push(node);
      if (node.isVisible && /Cancel Request/i.test(value)) cancelNodes.push(node);
      for (const child of node.children) collect(child);
    };
    for (const root of tree) collect(root);

    let bestMatch: {
      outletNode: ViewNode;
      requestNode: ViewNode;
      cancelNode: ViewNode;
      spread: number;
    } | null = null;
    for (const outletNode of outletNodes) {
      for (const requestNode of requestNodes) {
        for (const cancelNode of cancelNodes) {
          const centers = [outletNode, requestNode, cancelNode]
            .map((node) => node.bounds.y + node.bounds.height / 2);
          const spread = Math.max(...centers) - Math.min(...centers);
          if (spread <= 320 && (!bestMatch || spread < bestMatch.spread)) {
            bestMatch = { outletNode, requestNode, cancelNode, spread };
          }
        }
      }
    }
    return bestMatch;
  };

  const requestRow = await findRequestRow();
  if (!requestRow) {
    throw new Error(`Pending ${requestType} request for "${outlet}" did not expose a matching Cancel Request action.`);
  }
  const cancelLocators = await screen.getByText(/Cancel Request/i).all();
  let cancel = cancelLocators[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of cancelLocators) {
    const box = await candidate.boundingBox().catch(() => undefined);
    if (!box) continue;
    const distance = Math.abs(box.y - requestRow.cancelNode.bounds.y)
      + Math.abs(box.x - requestRow.cancelNode.bounds.x);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      cancel = candidate;
    }
  }
  if (!cancel) throw new Error(`Could not resolve Cancel Request for "${outlet}".`);
  await cancel.tap();

  // Tapping "Cancel Request" opens a confirmation dialog ("Are you sure you want to cancel this
  // pending ... request?" with NO / YES, CANCEL buttons); the request isn't actually cancelled until
  // that second confirmation tap happens.
  const confirmCancel = screen.getByText(/YES,?\s*CANCEL/i)
    .or(screen.getByLabel('YES, CANCEL', { exact: false }));
  await expect(confirmCancel).toBeVisible({ timeout: 5_000 });
  await confirmCancel.tap();

  // Stay anchored to the Pending approvals screen while checking removal; otherwise a navigation
  // away from the list would also make findRequestRow() return null and create a false pass.
  await expect(pendingTab).toBeVisible({ timeout: 10_000 });
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (!(await findRequestRow())) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Pending ${requestType} request for "${outlet}" remained after cancellation.`);
};

const reopenCancelledOutlet = async (screen: Screen, visitPage: VisitPage, outlet: string): Promise<void> => {
  await new LoginPage(screen).recoverToHome();
  const todaysPlan = screen.getByText("Today's Plan", { exact: true })
    .or(screen.getByText('Today’s Plan', { exact: true }));
  await expect(todaysPlan).toBeVisible({ timeout: 10_000 });
  await todaysPlan.tap();
  await visitPage.openOutlet(outlet, true);
  await expect(screen.getByText(/Outlet Details|Outlet Summary/i)).toBeVisible({ timeout: 10_000 });
};

const ensureClosureRequestPending = async (visitPage: VisitPage): Promise<void> => {
  await visitPage.submitClosureRequest();
};

const ensureLocationCorrectionPending = async (
  visitPage: VisitPage,
  outlet: string,
  distanceMeters: number,
  reason: string,
): Promise<void> => {
  await visitPage.setGeofenceDistance(outlet, distanceMeters);
  await visitPage.submitLocationCorrectionRequest(reason);
};

test('TC-044-CANCEL-CLOSURE - Cancelling a pending closure restores normal outlet state', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = await openOutletAtItsSavedLocation(screen);
  const outlet = visitPage.getActiveOutletName();
  await ensureClosureRequestPending(visitPage);
  await openPendingApprovalRequest(
    screen,
    getCaseData('TC-044-CANCEL-CLOSURE').approvalType as string,
    outlet,
  );
  await reopenCancelledOutlet(screen, visitPage, outlet);
  await visitPage.ensureGeofenceState(outlet, 'inside');
  await visitPage.expectMarkAsClosedEnabled(true);
  await expect(screen.getByText(/pending closure|closed:\s*pending|sent for approval/i)).toBeHidden({ timeout: 10_000 });
});

test('TC-045 - Cancelling a pending location correction restores geofence gating', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = await openOutletAtItsSavedLocation(screen);
  const outlet = visitPage.getActiveOutletName();
  await ensureLocationCorrectionPending(
    visitPage,
    outlet,
    getCaseData('TC-045').correctionDistanceMeters as number,
    getCaseData('TC-045').reason as string,
  );
  await openPendingApprovalRequest(screen, getCaseData('TC-045').approvalType as string, outlet);
  await reopenCancelledOutlet(screen, visitPage, outlet);
  await visitPage.ensureGeofenceState(outlet, 'inside');
  await visitPage.expectStartVisitEnabled(true);
  await expect(screen.getByText(/Update Outlet Location|Request Location Correction/i)).toBeVisible({ timeout: 10_000 });
  await expect(screen.getByText(/Location update is pending approval/i)).toBeHidden({ timeout: 10_000 });
});

// Skipped: "Request for New Outlet" requires the device to be at a genuinely different real-world
// location (its own "You must be at the new outlet's location" disclaimer gates the form), so it
// cannot be submitted deterministically from this device/location the way closure and location
// correction requests can. It remains fixture-dependent like TC-036 above.
test.skip('TC-046 - Cancelling a pending New Outlet removes the pending request', async ({ screen }) => {
  await ensureVisitReady(screen);
  await openPendingApprovalRequest(screen, 'New Outlet', 'fixture-provided outlet');
});

test('TC-058 - Saving a task does not increment the completed tally until completion', async ({ screen }) => {
  await ensureVisitReady(screen);
  const visitPage = new VisitPage(screen);
  await visitPage.ensureVisitTasks();
  const tallyBefore = await visitPage.getCompletedTaskTally();
  expect(tallyBefore).not.toBeNull();

  await openConfiguredNumericTask(visitPage, 'TC-058');
  // Fill every outstanding mandatory field this task exposes (per the real app, its "Leave task? >
  // SAVE" control blocks with a "Missing required fields" banner unless every required field has a
  // value), then leave via that SAVE path rather than the "Submit Task" button.
  const filledCount = await visitPage.fillAllRequiredTaskFields(getCaseData('TC-058').fallbackFieldValue as number);
  expect(filledCount).toBeGreaterThan(0);
  const saveOutcome = await visitPage.leaveTaskAndSave();
  expect(saveOutcome).toBe('saved');

  await visitPage.ensureVisitTasks();
  // Scroll back to the top of the Visit Tasks list so the completion tally header (scrolled past
  // while filling task fields further down the list) is back on screen before reading it.
  await screen.swipe('down', { distance: 600, duration: 400 }).catch(() => undefined);
  const tallyAfter = await visitPage.getCompletedTaskTally();
  expect(tallyAfter).not.toBeNull();
  console.log(`TC-058: completed tally before=${JSON.stringify(tallyBefore)}, after=${JSON.stringify(tallyAfter)}`);
  // Data was saved (SAVE succeeded, not blocked), but the task was never explicitly submitted via
  // "Submit Task", so it must not count toward the visit's overall completed-task tally.
  expect(tallyAfter).toEqual(tallyBefore);
});
