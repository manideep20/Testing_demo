import { expect, test } from '@mobilewright/test';
import type { Locator, Screen } from '@mobilewright/core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureVisitPhoto } from './visit-camera.page.js';
import { dismissExitPromptIfVisible, mockDeviceLocation } from './login.page.js';

const execFileAsync = promisify(execFile);

export class VisitPage {
  private readonly screen: Screen;
  private activeOutlet?: string;
  private numericField?: Locator;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  // Guards a single device-driven action (e.g. a tap) with a hard wall-clock deadline. The underlying
  // driver's own per-locator timeouts only re-check the deadline *after* a view-hierarchy fetch
  // resolves, so if the app itself is frozen/ANR'd, that fetch can hang indefinitely and the normal
  // timeout never fires. This wraps such calls so a frozen app surfaces as a clear, fast failure
  // instead of hanging the whole test run for minutes.
  private async withWatchdog<T>(label: string, action: () => Promise<T>, ms = 20_000): Promise<T> {
    let timer: NodeJS.Timeout;
    const watchdog = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Visit Flow: "${label}" did not respond within ${ms}ms — the app may be frozen/unresponsive.`)),
        ms,
      );
    });
    try {
      return await Promise.race([action(), watchdog]);
    } finally {
      clearTimeout(timer!);
    }
  }

  getActiveOutletName(): string {
    if (!this.activeOutlet) {
      throw new Error('No active outlet has been opened.');
    }
    return this.activeOutlet;
  }

  private async returnToOutletList(outlet: string): Promise<void> {
    const detailsVisible = await this.screen.getByText(/Outlet Details|Outlet Summary/i)
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (!detailsVisible) {
      if (await this.screen.getByText(outlet, { exact: true }).isVisible({ timeout: 1_000 }).catch(() => false)) {
        return;
      }
      throw new Error(`Cannot return to the outlet list because Outlet Details is not visible for "${outlet}".`);
    }

    // Prefer an in-screen back-arrow/close affordance over the hardware BACK key: on this app, BACK
    // from Outlet Details pops all the way to the Android root and triggers the native "Exit App"
    // confirmation instead of returning to the outlet list, which is what was causing that prompt to
    // flash repeatedly on-screen every time a non-matching outlet was tried during a scan.
    const inScreenBackCandidates = [
      this.screen.getByLabel('Back'),
      this.screen.getByLabel('back'),
      this.screen.getByLabel('Navigate up'),
      this.screen.getByLabel('Navigate back'),
      this.screen.getByLabel('Close'),
    ];
    let tappedInScreenBack = false;
    for (const candidate of inScreenBackCandidates) {
      if (await candidate.isVisible({ timeout: 300 }).catch(() => false)) {
        await candidate.tap().catch(() => undefined);
        tappedInScreenBack = true;
        break;
      }
    }
    if (!tappedInScreenBack) {
      await this.screen.pressButton('BACK');
    }
    await dismissExitPromptIfVisible(this.screen);
    await expect(this.screen.getByText(outlet, { exact: true })).toBeVisible({ timeout: 10_000 });
  }

  private async swipeFullApp(startX: number, startY: number): Promise<void> {
    const adbPath = `${process.env.LOCALAPPDATA ?? ''}\\Android\\Sdk\\platform-tools\\adb.exe`;
    const { stdout } = await execFileAsync(adbPath, ['devices'], { windowsHide: true });
    const deviceId = stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find(([id, state]) => id && state === 'device' && !id.startsWith('emulator-'))?.[0];
    if (!deviceId) {
      throw new Error('No connected real Android device was found for the full-screen swipe.');
    }

    const { stdout: sizeOutput } = await execFileAsync(adbPath, ['-s', deviceId, 'shell', 'wm', 'size'], {
      windowsHide: true,
    });
    const sizeMatch = sizeOutput.match(/Physical size:\s*(\d+)x(\d+)/i);
    const logicalWidth = 392;
    const logicalHeight = 850;
    const displayWidth = sizeMatch ? Number(sizeMatch[1]) : logicalWidth;
    const displayHeight = sizeMatch ? Number(sizeMatch[2]) : logicalHeight;
    const scaleX = displayWidth / logicalWidth;
    const scaleY = displayHeight / logicalHeight;
    const physicalStartX = Math.round(Math.min(displayWidth - 1, Math.max(0, startX * scaleX)));
    const requestedStartY = startY * scaleY;
    // Keep the gesture away from Android's bottom navigation/recents gesture area.
    const physicalStartY = Math.round(Math.min(displayHeight * 0.78, Math.max(displayHeight * 0.45, requestedStartY)));
    const physicalEndY = Math.round(Math.max(displayHeight * 0.18, physicalStartY - displayHeight * 0.42));

    await execFileAsync(adbPath, [
      '-s',
      deviceId,
      'shell',
      'input',
      'swipe',
      String(physicalStartX),
      String(physicalStartY),
      String(physicalStartX),
      String(physicalEndY),
      '800',
    ], { windowsHide: true });
  }

  async openAnyOutletFromList(
    detailPattern: RegExp = /You are\s+[\d,.]+\s*(?:m|km)\s+away|Move within 100m|outside the geofence|farther than 100m/i,
    allowPendingApproval = false,
    allowNoDetailMatch = false,
  ): Promise<string | undefined> {
    const excludedLabels = new Set([
      'MJP',
      "Today's Plan",
      'Today’s Plan',
      'Check out for the day',
      'Check in for the day',
      'Mark attendance',
      'Profile',
      'List',
      'List View',
      'Calendar',
      'Calendar View',
      'Planned',
      'Unplanned',
      'Pending',
      'Visited',
      'Yet to Visit',
      'Special Assignment',
      'Start Visit',
      'Missed Outlets',
      'Day Summary',
      'Resume',
      'Back',
      'Recents',
      'Home',
      'Edge panels',
      'Attendance',
      'History',
      'PJP',
      'Track Approvals',
      'Awaiting Sync',
    ]);

    const triedOutlets = new Set<string>();
    const eligibleOutlets = new Set<string>();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // Scrolling/swiping through the outlet list near the bottom of the screen can be misread as
      // Android's "swipe up to go home"/back gesture, popping an "Exit App" confirmation on top of the
      // list. Dismiss it at the start of every scan iteration so it can't repeatedly interrupt scanning
      // or a subsequent Start Visit tap (previously only checked deep inside the tap-retry loop).
      if (await dismissExitPromptIfVisible(this.screen)) {
        console.log(`Visit Flow: dismissed an "Exit App" prompt before scanning viewport ${attempt + 1}.`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const nodes = await this.screen.viewTree();
      const activeResume = this.screen.getByText('Resume', { exact: true })
        .or(this.screen.getByLabel('Resume'));
      if (await activeResume.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log(
          `Visit Flow: Resume is visible, but continuing to scan outlet cards before considering the active visit.`,
        );
      }
      if (attempt === 0) {
        const checkoutNode = nodes
          .flatMap((root) => {
            const matches: Array<(typeof nodes)[number]> = [];
            const collectCheckout = (node: (typeof nodes)[number]): void => {
              const text = node.text?.trim() || node.label?.trim();
              if (node.isVisible && /Check out for the day/i.test(text ?? '')) {
                matches.push(node);
              }
              for (const child of node.children) {
                collectCheckout(child);
              }
            };
            collectCheckout(root);
            return matches;
          })[0];
        if (checkoutNode) {
          await this.swipeFullApp(
            checkoutNode.bounds.x + checkoutNode.bounds.width / 2,
            checkoutNode.bounds.y + checkoutNode.bounds.height + 20,
          );
          continue;
        }
      }

      const texts: string[] = [];
      const collect = (node: (typeof nodes)[number]): void => {
        const text = node.text?.trim() || node.label?.trim();
        if (
          node.isVisible
          && text
          && text.length > 2
          && !excludedLabels.has(text)
          && !/^(Today|Yesterday|Tomorrow|Home|Dashboard|Notifications?)$/i.test(text)
          && !/^(Today's|Today’s) Plan(?:,\s*Outlets planned for today)?$/i.test(text)
          && !/^Outlets planned for today$/i.test(text)
          && !/^(Planned|Completed|Remaining|Unplanned)\s*:?\s*\d*$/i.test(text)
        ) {
          texts.push(text);
        }
        for (const child of node.children) {
          collect(child);
        }
      };
      for (const node of nodes) {
        collect(node);
      }

      const outletTexts = [...new Set(texts)].sort((left, right) => {
        return left.localeCompare(right);
      }).filter((text) => (
        !/^\d+\s*,?\s*(?:missed|planned|visited|outlets?)/i.test(text)
        && !/^(?:missed|planned|visited)\s+outlets?$/i.test(text)
        && !/^(?:pending|completed|remaining|planned|unplanned|visited|yet to visit|special assignment)$/i.test(text)
        // Card status badges like "Pending Approval" and "Closed: Pending Approval" are compound
        // phrases, not single words, so they slip past the exact-match exclusion above; exclude them
        // explicitly so they aren't mistaken for the outlet's own title text.
        && !/^(?:closed\s*:\s*)?pending approval$/i.test(text)
        && !/^outlet marked as closed/i.test(text)
        && !/sent for approval/i.test(text)
        && !/^you are\b|^move within\b|^outside the geofence\b|^farther than\b/i.test(text)
        && !/^start visit$/i.test(text)
        && !/^check(?:\s+out|\s+in)\b/i.test(text)
        // Status bar / notification-shade accessibility descriptions (e.g. "Battery charging, 79
        // percent.", "Wi-Fi signal full.", "Route Apex notification:") can leak into the view tree if
        // the notification shade is ever pulled open; these always end in a period or colon, unlike
        // real outlet names, so filter them out defensively.
        && !/[.:]$/.test(text)
        && !/^\d{1,2}:\d{2}$/.test(text)
        && !/signal|vibrate|notification|percent\b/i.test(text)
      ));
      const outletTitleTexts = outletTexts.filter((text) => (
        !/^code\s*:/i.test(text)
        && !/^(?:on|off|general)$/i.test(text)
        && !/^(?:shop|door|house|h\.?\s*no\.?|flat|plot|unit)\s*(?:no\.?)?\s*[\w-]+/i.test(text)
        && !/^\d+\s*[,-]/.test(text)
        && !(((text.match(/,/g)?.length ?? 0) >= 2) && /\d/.test(text))
        && !(text.includes(',') && /\b(?:road|street|marg|nagar|sector|chowk|colony|city|town|village|highway)\b/i.test(text))
      ));

      const outletRecords = outletTitleTexts.map((text) => {
        const matchingNodes: Array<(typeof nodes)[number]> = [];
        const collectMatching = (node: (typeof nodes)[number]): void => {
          const nodeText = node.text?.trim() || node.label?.trim() || '';
          if (node.isVisible && nodeText === text) matchingNodes.push(node);
          for (const child of node.children) collectMatching(child);
        };
        for (const root of nodes) collectMatching(root);
        const node = matchingNodes.sort(
          (left, right) => (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height),
        )[0];
        return { text, node };
      }).filter((record): record is { text: string; node: (typeof nodes)[number] } => Boolean(record.node));

      const outletRecordsWithCardMetadata = outletRecords.filter((record) => {
        const center = record.node.bounds.y + (record.node.bounds.height / 2);
        const otherCenters = outletRecords
          .filter((candidate) => candidate !== record)
          .map((candidate) => candidate.node.bounds.y + (candidate.node.bounds.height / 2));
        const previousCenter = record.node.bounds.y;
        const nextCenter = otherCenters.filter((value) => value > center).sort((a, b) => a - b)[0];
        const metadata: string[] = [];
        const collectMetadata = (node: (typeof nodes)[number]): void => {
          const value = (node.text ?? node.label ?? '').trim();
          const nodeCenter = node.bounds.y + (node.bounds.height / 2);
          const inCard = nodeCenter >= (previousCenter ?? 0)
            && nodeCenter < (nextCenter ?? Number.POSITIVE_INFINITY);
          if (node.isVisible && inCard && /code\s*:|shop\s+no|road|street|address|pincode/i.test(value)) {
            metadata.push(value);
          }
          for (const child of node.children) collectMetadata(child);
        };
        for (const root of nodes) collectMetadata(root);
        if (metadata.length > 0) {
          return true;
        }

        const hasStartVisitAction = (node: (typeof nodes)[number]): boolean => {
          const value = (node.text ?? node.label ?? '').trim();
          const nodeCenter = node.bounds.y + (node.bounds.height / 2);
          const inCard = node.isVisible
            && nodeCenter >= previousCenter
            && nodeCenter < (nextCenter ?? Number.POSITIVE_INFINITY);
          if (inCard && value === 'Start Visit') {
            return true;
          }
          return node.children.some((child) => hasStartVisitAction(child));
        };
        return nodes.some((root) => hasStartVisitAction(root));
      });

      const eligibleOutletNames = outletRecordsWithCardMetadata.filter((record) => {
        const center = record.node.bounds.y + (record.node.bounds.height / 2);
        const otherCenters = outletRecords
          .filter((candidate) => candidate !== record)
          .map((candidate) => candidate.node.bounds.y + (candidate.node.bounds.height / 2));
        const previousCenter = record.node.bounds.y;
        const nextCenter = otherCenters.filter((value) => value > center).sort((a, b) => a - b)[0];
        const startVisitNodes: Array<(typeof nodes)[number]> = [];
        const blockedNodes: Array<(typeof nodes)[number]> = [];
        const collectCardState = (node: (typeof nodes)[number]): void => {
          const text = (node.text ?? node.label ?? '').trim();
          const nodeCenter = node.bounds.y + (node.bounds.height / 2);
          const inCard = nodeCenter >= (previousCenter === undefined ? 0 : previousCenter)
            && nodeCenter < (nextCenter ?? Number.POSITIVE_INFINITY);
          if (node.isVisible && inCard) {
            if (text === 'Start Visit') startVisitNodes.push(node);
            // "Pending Approval"/"sent for approval" badges appear on outlets that still have an
            // active "Start Visit" button (a pending closure/location request doesn't remove the
            // action) -- only treat them as blocking when the caller hasn't opted into pending
            // outlets via allowPendingApproval. "Closed"/"Completed"/"Visited" always block, since
            // those cards genuinely have no Start Visit action left.
            const isPendingApprovalReason = /pending approval|pending location|sent for approval/i.test(text);
            const isHardBlockedReason = /(?<!pending )closed|completed|visited/i.test(text);
            if ((isPendingApprovalReason && !allowPendingApproval) || isHardBlockedReason) {
              blockedNodes.push(node);
            }
          }
          for (const child of node.children) collectCardState(child);
        };
        for (const root of nodes) collectCardState(root);
        return blockedNodes.length === 0 && startVisitNodes.length > 0;
      }).map((record) => record.text);
      console.log(
        `Visit Flow: scanned viewport ${attempt + 1}; found ${eligibleOutletNames.length} `
        + `non-pending eligible outlet(s): ${eligibleOutletNames.join(', ') || 'none'}`,
      );
      for (const eligibleOutlet of eligibleOutletNames) {
        eligibleOutlets.add(eligibleOutlet);
      }

      const outletCenters = outletRecords
        .map((record) => record.node.bounds.y + (record.node.bounds.height / 2))
        .sort((left, right) => left - right);

      for (const record of outletRecordsWithCardMetadata.filter((candidate) => (
        eligibleOutletNames.includes(candidate.text)
      // Try the outlet nearest the top of the current viewport first (not alphabetical order): a
      // card near the bottom of the screen is far more likely to sit right above the Android gesture
      // nav bar, where scrollIntoViewIfNeeded()'s swipe-to-reveal can be misread as a system
      // home/back gesture and trigger a spurious "Exit App" prompt loop, wasting minutes per outlet.
      )).sort((left, right) => left.node.bounds.y - right.node.bounds.y)) {
        const text = record.text;
        if (triedOutlets.has(text)) {
          continue;
        }
        triedOutlets.add(text);
        const candidate = this.screen.getByText(text, { exact: true });
        if (!(await candidate.isVisible({ timeout: 300 }).catch(() => false))) {
          continue;
        }
        await candidate.scrollIntoViewIfNeeded({ maxSwipes: 8 }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const refreshedNodes = await this.screen.viewTree();
        const refreshedOutletNodes: Array<(typeof refreshedNodes)[number]> = [];
        const collectRefreshedOutlet = (node: (typeof refreshedNodes)[number]): void => {
          const value = (node.text ?? node.label ?? '').trim();
          if (node.isVisible && value === text) {
            refreshedOutletNodes.push(node);
          }
          for (const child of node.children) collectRefreshedOutlet(child);
        };
        for (const root of refreshedNodes) collectRefreshedOutlet(root);
        const outletNode = refreshedOutletNodes.sort(
          (left, right) => (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height),
        )[0];
        if (!outletNode) {
          continue;
        }
        const refreshedOutletCenters: number[] = [];
        const collectRefreshedOutletCenters = (node: (typeof refreshedNodes)[number]): void => {
          const value = (node.text ?? node.label ?? '').trim();
          if (
            node.isVisible
            && outletTitleTexts.includes(value)
            && value !== text
          ) {
            refreshedOutletCenters.push(node.bounds.y);
          }
          for (const child of node.children) collectRefreshedOutletCenters(child);
        };
        for (const root of refreshedNodes) collectRefreshedOutletCenters(root);
        const nextRefreshedOutletY = refreshedOutletCenters
          .filter((value) => value > outletNode.bounds.y)
          .sort((left, right) => left - right)[0] ?? Number.POSITIVE_INFINITY;
        const outletCenters = outletRecords
          .filter((candidate) => candidate.text !== text)
          .map((candidate) => candidate.node.bounds.y + (candidate.node.bounds.height / 2))
          .sort((left, right) => left - right);
        const outletCenter = outletNode.bounds.y + (outletNode.bounds.height / 2);
        const nextOutletCenter = outletCenters.find((center) => center > outletCenter) ?? Number.POSITIVE_INFINITY;
        const outletRegionStartY = outletNode.bounds.y;
        const nextOutletY = Number.isFinite(nextOutletCenter)
          ? nextOutletCenter
          : Number.POSITIVE_INFINITY;
        const withinOutletRegion = (node: (typeof nodes)[number]): boolean => (
          (node.bounds.y + (node.bounds.height / 2)) >= outletRegionStartY
          && (node.bounds.y + (node.bounds.height / 2)) < nextOutletY
        );
        const nearbyStatusNodes: Array<(typeof nodes)[number]> = [];
        const nearbyStartVisitNodes: Array<(typeof nodes)[number]> = [];
        const collectActions = (node: (typeof refreshedNodes)[number]): void => {
          const nodeText = node.text?.trim() || node.label?.trim() || '';
          if (node.isVisible && withinOutletRegion(node)) {
            if (
              /pending approval|location update is pending|pending location correction|closed:\s*pending approval|outlet marked as closed|sent for approval|closure request/i.test(nodeText)
            ) {
              nearbyStatusNodes.push(node);
            }
            if (nodeText === 'Start Visit') nearbyStartVisitNodes.push(node);
          }
          for (const child of node.children) collectActions(child);
        };
        for (const root of refreshedNodes) collectActions(root);
        if (nearbyStatusNodes.length > 0 && !allowPendingApproval) {
          console.log(`Visit Flow: skipping outlet "${text}" because its card is pending or closed.`);
          continue;
        }
        const completedNodes: Array<(typeof refreshedNodes)[number]> = [];
        const collectCompleted = (node: (typeof refreshedNodes)[number]): void => {
          const nodeText = node.text?.trim() || node.label?.trim() || '';
          if (
            node.isVisible
            && withinOutletRegion(node)
            && /(?:completed|visited|already visited|visit completed)/i.test(nodeText)
            && !/^(?:Planned|Completed|Remaining|Unplanned)\s*:?\s*\d*$/i.test(nodeText)
          ) {
            completedNodes.push(node);
          }
          for (const child of node.children) collectCompleted(child);
        };
        for (const root of refreshedNodes) collectCompleted(root);
        if (completedNodes.length > 0 && !allowPendingApproval) {
          console.log(`Visit Flow: skipping outlet "${text}" because its card is completed or already visited.`);
          continue;
        }
        const startVisitNode = nearbyStartVisitNodes
          .filter((node) => (
            node.bounds.y > outletNode.bounds.y + outletNode.bounds.height
            && node.bounds.y < nextRefreshedOutletY
          ))
          .sort((left, right) => left.bounds.y - right.bounds.y)[0];
        if (startVisitNode) {
          console.log(`Visit Flow: tapping eligible outlet "${text}" Start Visit.`);
          for (let tapAttempt = 0; tapAttempt < 6; tapAttempt += 1) {
            if (await dismissExitPromptIfVisible(this.screen)) {
              await candidate.scrollIntoViewIfNeeded({ maxSwipes: 8 }).catch(() => undefined);
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            // The very first Start Visit tap in a fresh app session can trigger a one-time OS location
            // permission dialog that fully covers this outlet card and swallows the tap; nothing else in
            // this loop dismisses it, which previously caused every retry (and the whole outer scan) to
            // silently fail with "no eligible outlets found" even though a valid outlet was tapped.
            for (const permission of [
              this.screen.getByText('While using the app', { exact: true }),
              this.screen.getByText('Only this time', { exact: true }),
              this.screen.getByText('Allow all the time', { exact: true }),
              this.screen.getByText('Allow', { exact: true }),
            ]) {
              if (await permission.isVisible({ timeout: 300 }).catch(() => false)) {
                await permission.tap().catch(() => undefined);
                await new Promise((resolve) => setTimeout(resolve, 250));
                break;
              }
            }
            // Re-read the live tree only to work out WHICH on-screen "Start Visit" occurrence belongs to
            // this outlet's card (several outlet cards with their own Start Visit can be visible at
            // once); this is read-only disambiguation, not a coordinate we tap ourselves.
            const liveNodes = await this.screen.viewTree();
            const liveStartVisitNodes: Array<(typeof liveNodes)[number]> = [];
            const collectLiveStartVisit = (node: (typeof liveNodes)[number]): void => {
              const value = (node.text ?? node.label ?? '').trim();
              const centerY = node.bounds.y + node.bounds.height / 2;
              if (
                node.isVisible
                && value === 'Start Visit'
                && centerY > outletNode.bounds.y + outletNode.bounds.height
                && centerY < nextRefreshedOutletY
              ) {
                liveStartVisitNodes.push(node);
              }
              for (const child of node.children) collectLiveStartVisit(child);
            };
            for (const root of liveNodes) collectLiveStartVisit(root);
            const liveStartVisit = liveStartVisitNodes.sort(
              (left, right) => left.bounds.y - right.bounds.y,
            )[0];
            if (!liveStartVisit) {
              await candidate.scrollIntoViewIfNeeded({ maxSwipes: 8 }).catch(() => undefined);
              await new Promise((resolve) => setTimeout(resolve, 250));
              continue;
            }
            // Tap through the Locator API (getByText().nth(index).tap()) instead of a raw
            // screen.tap(x, y) with our own coordinate math — the locator re-resolves the element's
            // current bounds and taps its own dynamically-computed center at tap time, the same way every
            // other successful tap in this codebase works, with no hardcoded pixel offsets or margins of
            // our own that could drift out of sync with the device's actual layout.
            const startVisitLocators = await this.screen.getByText('Start Visit', { exact: true }).all();
            if (startVisitLocators.length === 0) {
              throw new Error(`Start Visit action disappeared for outlet "${text}" after scrolling.`);
            }
            let matchedLocator = startVisitLocators[0];
            let matchedDistance = Number.POSITIVE_INFINITY;
            for (const locatorCandidate of startVisitLocators) {
              const box = await locatorCandidate.boundingBox().catch(() => undefined);
              if (!box) continue;
              const distance = Math.abs(box.y - liveStartVisit.bounds.y) + Math.abs(box.x - liveStartVisit.bounds.x);
              if (distance < matchedDistance) {
                matchedDistance = distance;
                matchedLocator = locatorCandidate;
              }
            }
            await matchedLocator.scrollIntoViewIfNeeded({ maxSwipes: 8 }).catch(() => undefined);
            await matchedLocator.tap().catch(() => undefined);
            if (await this.screen.getByText(/Outlet Details|Outlet Summary/i)
              .isVisible({ timeout: 2_000 }).catch(() => false)) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (!(await this.screen.getByText(/Outlet Details|Outlet Summary/i).isVisible({ timeout: 500 }).catch(() => false))) {
            console.log(
              `Visit Flow: Start Visit tap for "${text}" never opened Outlet Details after all retries; `
              + `skipping this outlet rather than silently treating it as opened.`,
            );
            continue;
          }
        } else {
          console.log(
            `Visit Flow: skipping outlet "${text}" because its card ${
              completedNodes.length > 0 ? 'is completed/visited and has' : 'has'
            } no Start Visit action.`,
          );
          continue;
        }
        const detailTexts: string[] = [];
        const collectDetailText = (node: (typeof nodes)[number]): void => {
          const nodeText = node.text?.trim() || node.label?.trim() || '';
          if (node.isVisible && nodeText) {
            detailTexts.push(nodeText);
          }
          for (const child of node.children) collectDetailText(child);
        };
        let combinedDetailText = '';
        for (let stateAttempt = 0; stateAttempt < 6; stateAttempt += 1) {
          detailTexts.length = 0;
          const detailNodes = await this.screen.viewTree();
          for (const root of detailNodes) collectDetailText(root);
          combinedDetailText = detailTexts.join(' ').replace(/\s+/g, ' ').trim();
          if (
            detailPattern.test(combinedDetailText)
            || /pending location update|location update is pending approval|another request cannot be raised until it is approved|start visit is disabled until approval|closed:\s*pending approval|outlet marked as closed|sent for approval|you are within range|ready to visit|you are\s+[\d,.]+\s*(?:m|km)\s+away|move within 100m|outside the geofence|farther than 100m/i.test(combinedDetailText)
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const pendingDetailText = detailTexts.find((value) => (
          /pending location update|location update is pending approval|another request cannot be raised until it is approved|start visit is disabled until approval|closed:\s*pending approval|outlet marked as closed|sent for approval/i.test(value)
        )) ?? (
          /pending location update|location update is pending approval|another request cannot be raised until it is approved|start visit is disabled until approval|closed:\s*pending approval|outlet marked as closed|sent for approval/i.test(combinedDetailText)
            ? combinedDetailText
            : undefined
        );
        if (pendingDetailText && !allowPendingApproval) {
          console.log(`Visit Flow: skipping outlet "${text}" because Outlet Details reports a pending or closed state: ${pendingDetailText}`);
          await this.returnToOutletList(text);
          continue;
        }
        const matchedDetailText = detailTexts.find((value) => detailPattern.test(value))
          ?? (detailPattern.test(combinedDetailText) ? combinedDetailText : undefined);
        if (matchedDetailText) {
          console.log(`Visit Flow: outlet "${text}" matched detail state: ${matchedDetailText}`);
          this.activeOutlet = text;
          return text;
        }
        if (await this.screen.getByText(/Outlet Details|Outlet Summary/i).isVisible({ timeout: 500 }).catch(() => false)) {
          if (allowNoDetailMatch) {
            console.log(`Visit Flow: outlet "${text}" opened Outlet Details without a matching distance label.`);
            this.activeOutlet = text;
            return text;
          }
          console.log(`TC-033: outlet "${text}" has no distance warning; returning to outlet list.`);
          await this.returnToOutletList(text);
          continue;
        }
        if (await this.screen.getByText('Check out for the day', { exact: true }).isVisible({ timeout: 500 }).catch(() => false)) {
          continue;
        }
        const cancelExit = this.screen.getByText('CANCEL', { exact: true });
        if (await cancelExit.isVisible({ timeout: 500 }).catch(() => false)) {
          await cancelExit.tap().catch(() => undefined);
        }
      }

      if (await this.screen.getByText(/Day Summary/i).isVisible({ timeout: 500 }).catch(() => false)) {
        console.log('Visit Flow: Day Summary is visible after scrolling the full Home screen.');
      }

      const checkoutNode = nodes
        .flatMap((root) => {
          const matches: Array<(typeof nodes)[number]> = [];
          const collectCheckout = (node: (typeof nodes)[number]): void => {
            const text = node.text?.trim() || node.label?.trim();
            if (node.isVisible && /Check out for the day/i.test(text ?? '')) {
              matches.push(node);
            }
            for (const child of node.children) {
              collectCheckout(child);
            }
          };
          collectCheckout(root);
          return matches;
        })[0];

      if (checkoutNode) {
        await this.swipeFullApp(
          checkoutNode.bounds.x + checkoutNode.bounds.width / 2,
          checkoutNode.bounds.y + checkoutNode.bounds.height + 20,
        );
        continue;
      }

      const checkoutButton = this.screen.getByText('Check out for the day', { exact: true });
      if (await checkoutButton.isVisible({ timeout: 500 }).catch(() => false)) {
        const buttonNode = (await this.screen.viewTree())
          .flatMap((root) => {
            const matches: Array<(typeof nodes)[number]> = [];
            const collectButton = (node: (typeof nodes)[number]): void => {
              const text = node.text?.trim() || node.label?.trim();
              if (node.isVisible && text === 'Check out for the day') {
                matches.push(node);
              }
              for (const child of node.children) {
                collectButton(child);
              }
            };
            collectButton(root);
            return matches;
          })[0];
        if (buttonNode) {
          await this.swipeFullApp(
            buttonNode.bounds.x + buttonNode.bounds.width / 2,
            buttonNode.bounds.y + buttonNode.bounds.height + 20,
          );
          continue;
        }
      }

      await this.screen.swipe('up', {
        distance: 560,
        duration: 800,
      });
      continue;
    }

    console.log(
      `Visit Flow: consolidated eligible outlets after scanning the full list: `
      + `${eligibleOutlets.size} non-pending outlet(s): ${[...eligibleOutlets].join(', ') || 'none'}`,
    );
    const finalNodes = await this.screen.viewTree();
    const visibleUi: string[] = [];
    const collectVisibleUi = (node: (typeof finalNodes)[number]): void => {
      const value = (node.text ?? node.label ?? '').trim();
      if (node.isVisible && value) {
        visibleUi.push(value);
      }
      for (const child of node.children) collectVisibleUi(child);
    };
    for (const root of finalNodes) collectVisibleUi(root);
    console.log(
      `Visit Flow: no eligible outlets are available; current UI: `
      + `${[...new Set(visibleUi)].join(' | ') || 'no visible text'}`,
    );
    console.log(
      'No Start Visit eligible outlets found; no outlet-specific action was performed. '
      + `Visible UI: ${[...new Set(visibleUi)].join(' | ') || 'no visible text'}`,
    );
    return undefined;
  }

  async openOutlet(outlet: string, allowOutletTextFallback = false): Promise<void> {
    this.activeOutlet = outlet;
    const outletCard = this.screen.getByText(outlet, { exact: true });
    await outletCard.scrollIntoViewIfNeeded({ maxSwipes: 8 }).catch(() => undefined);
    await expect(outletCard).toBeVisible({ timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const tapFreshStartVisit = async (): Promise<boolean> => {
      const freshNodes = await this.screen.viewTree();
      type FreshNode = (typeof freshNodes)[number];
      const outletNodes: FreshNode[] = [];
      const startVisitNodes: FreshNode[] = [];
      const possibleNextOutletNodes: FreshNode[] = [];
      const isPossibleOutletTitle = (text: string): boolean => (
        text.length > 2
        && text.length < 100
        && !/^(?:code\s*:|address|road|street|pincode|shop\s*no|start visit|pending|completed|visited|on|off)$/i.test(text)
        // These can appear with trailing content on the same line (e.g. "Code: CUS_RHTHR5001",
        // "Pending Approval"), so match them as a leading substring rather than requiring the whole
        // node's text to equal just the label -- otherwise they slip through and get mistaken for a
        // second outlet name, wrongly narrowing the search window below the real Start Visit button.
        && !/^(?:code\s*:|pending)/i.test(text)
        && !/^\d[\d, .-]*$/.test(text)
        && !/^(?:today|planned|remaining|unplanned|visited|yet to visit|mjp|pjp|attendance|history|recents|back|home|day summary)$/i.test(text)
      );
      const collect = (node: FreshNode): void => {
        const text = node.text?.trim() || node.label?.trim() || '';
        if (node.isVisible && text === outlet) outletNodes.push(node);
        if (node.isVisible && text === 'Start Visit') startVisitNodes.push(node);
        if (node.isVisible && text !== outlet && isPossibleOutletTitle(text)) {
          possibleNextOutletNodes.push(node);
        }
        for (const child of node.children) collect(child);
      };
      for (const root of freshNodes) collect(root);
      const outletNode = outletNodes.sort(
        (left, right) => (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height),
      )[0];
      if (!outletNode) return false;
      const outletBottom = outletNode.bounds.y + outletNode.bounds.height;
      const nextOutletY = possibleNextOutletNodes
        .filter((node) => node.bounds.y > outletBottom)
        .map((node) => node.bounds.y)
        .sort((left, right) => left - right)[0] ?? Number.POSITIVE_INFINITY;
      const candidates = startVisitNodes
        .filter((node) => node.bounds.y >= outletBottom && node.bounds.y < nextOutletY)
        .sort((left, right) => left.bounds.y - right.bounds.y);
      const startVisit = candidates[0];
      if (!startVisit) return false;
      // Tap through the Locator API rather than a raw screen.tap(x, y): find the "Start Visit"
      // occurrence whose current bounds match the one just identified for this outlet's card, then let
      // the locator resolve and tap its own dynamically-computed center.
      const startVisitLocators = await this.screen.getByText('Start Visit', { exact: true }).all();
      let matchedLocator = startVisitLocators[0];
      let matchedDistance = Number.POSITIVE_INFINITY;
      for (const locatorCandidate of startVisitLocators) {
        const box = await locatorCandidate.boundingBox().catch(() => undefined);
        if (!box) continue;
        const distance = Math.abs(box.y - startVisit.bounds.y) + Math.abs(box.x - startVisit.bounds.x);
        if (distance < matchedDistance) {
          matchedDistance = distance;
          matchedLocator = locatorCandidate;
        }
      }
      if (!matchedLocator) return false;
      await matchedLocator.scrollIntoViewIfNeeded({ maxSwipes: 8 }).catch(() => undefined);
      await matchedLocator.tap().catch(() => undefined);
      return true;
    };

    const detailsPage = this.screen.getByText(/Outlet Details|Outlet Summary/i);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await detailsPage.isVisible({ timeout: 500 }).catch(() => false)) return;
      await outletCard.scrollIntoViewIfNeeded({ maxSwipes: 8 }).catch(() => undefined);
      if (await tapFreshStartVisit()) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (await detailsPage.isVisible({ timeout: 4_000 }).catch(() => false)) return;
      }
    }

    let nodes = await this.screen.viewTree();
    type ViewNode = (typeof nodes)[number];
    const collectOutletNodes = (roots: typeof nodes): ViewNode[] => {
      const found: ViewNode[] = [];
      const walk = (node: ViewNode): void => {
        const text = node.text?.trim() || node.label?.trim() || '';
        if (node.isVisible && text === outlet) found.push(node);
        for (const child of node.children) walk(child);
      };
      for (const root of roots) walk(root);
      return found;
    };
    let outletNodes = collectOutletNodes(nodes);
    for (let scrollAttempt = 0; scrollAttempt < 3 && outletNodes.length === 0; scrollAttempt += 1) {
      // The card may have scrolled out of view during the earlier Start Visit tap attempts; try to
      // scroll it back into view before giving up.
      await outletCard.scrollIntoViewIfNeeded({ maxSwipes: 8 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
      nodes = await this.screen.viewTree();
      outletNodes = collectOutletNodes(nodes);
    }
    const outletNode = outletNodes[0];
    if (!outletNode) {
      throw new Error(`Could not locate the visible outlet card for "${outlet}".`);
    }

    const otherOutletNames = new Set<string>();
    const collectOutletName = (node: ViewNode): void => {
      const text = node.text?.trim() || node.label?.trim() || '';
      if (
        node.isVisible
        && text !== outlet
        && text.length > 2
        && text.length < 100
        && !/^(?:code\s*:|address|road|street|pincode|shop\s*no|start visit|pending|completed|visited|on|off)$/i.test(text)
        // These can appear with trailing content on the same line (e.g. "Code: CUS_RHTHR5001",
        // "Pending Approval"), so match as a leading substring instead of requiring the whole node's
        // text to equal just the label -- see the matching comment in tapFreshStartVisit above.
        && !/^(?:code\s*:|pending)/i.test(text)
        && !/^\d[\d, .-]*$/.test(text)
        && !/^(?:today|planned|remaining|unplanned|visited|yet to visit|mjp|pjp|attendance|history|recents|back|home|day summary)$/i.test(text)
        && !/^(?:shop|door|house|h\.?\s*no\.?|flat|plot|unit)\s*(?:no\.?)?\s*[\w-]+/i.test(text)
        && !/^\d+\s*[,-]/.test(text)
        // Exclude address lines (e.g. "89, Ambala City Main Road, Ambala, Haryana"), which otherwise
        // get mistaken for a second outlet name on the same card and wrongly cut off the search for
        // this outlet's own Start Visit button.
        && !(text.includes(',') && /\d/.test(text))
        && !(text.includes(',') && /\b(?:road|street|marg|nagar|sector|chowk|colony|city|town|village|highway)\b/i.test(text))
      ) {
        otherOutletNames.add(text);
      }
      for (const child of node.children) collectOutletName(child);
    };
    for (const root of nodes) collectOutletName(root);
    // Only use the next distinct outlet name as an upper bound if it clearly comes after this outlet's
    // own Start Visit button; a bad match here previously caused a real, visible Start Visit button to
    // be filtered out. Fall back to no upper bound (nearest Start Visit below the outlet name wins).
    const nextOutletY = outletNodes
      .concat(
        [...otherOutletNames].flatMap((name) => {
          const matches: ViewNode[] = [];
          const collectNamed = (node: ViewNode): void => {
            const text = node.text?.trim() || node.label?.trim() || '';
            if (node.isVisible && text === name) matches.push(node);
            for (const child of node.children) collectNamed(child);
          };
          for (const root of nodes) collectNamed(root);
          return matches;
        }),
      )
      .map((node) => node.bounds.y)
      .filter((y) => y > outletNode.bounds.y + outletNode.bounds.height)
      .sort((left, right) => left - right)[0] ?? Number.POSITIVE_INFINITY;
    const startVisitNodes: ViewNode[] = [];
    const collectStartVisit = (node: ViewNode): void => {
      const text = node.text?.trim() || node.label?.trim() || '';
      if (
        node.isVisible
        && text === 'Start Visit'
        && node.bounds.y >= outletNode.bounds.y
        && node.bounds.y < nextOutletY
      ) {
        startVisitNodes.push(node);
      }
      for (const child of node.children) collectStartVisit(child);
    };
    for (const root of nodes) collectStartVisit(root);
    const startVisit = startVisitNodes.sort((left, right) => left.bounds.y - right.bounds.y)[0];
    if (!startVisit) {
      // Some outlet cards do not render a Start Visit label once the mocked GPS location is far from
      // the outlet (e.g. after ensureGeofenceDistance moves the device outside range); tapping the
      // outlet's own card still opens Outlet Details, which correctly renders the distance warning.
      // Use a text-based locator tap (re-resolves position live) rather than cached pixel bounds,
      // which can go stale if the list re-renders/scrolls between measurement and tap.
      console.log(`Visit Flow: no Start Visit label found on the "${outlet}" card; tapping the outlet card directly by text.`);
      const outletCardLocator = this.screen.getByText(outlet, { exact: true });
      await outletCardLocator.scrollIntoViewIfNeeded({ maxSwipes: 8 }).catch(() => undefined);
      await outletCardLocator.tap();
      if (await this.screen.getByText(/Outlet Details|Outlet Summary/i).isVisible({ timeout: 5_000 }).catch(() => false)) {
        return;
      }
      const afterTapNodes = await this.screen.viewTree();
      const afterTapTexts: string[] = [];
      const collectAfterTap = (node: (typeof afterTapNodes)[number]): void => {
        const text = node.text?.trim() || node.label?.trim() || '';
        if (node.isVisible && text) afterTapTexts.push(text);
        for (const child of node.children) collectAfterTap(child);
      };
      for (const root of afterTapNodes) collectAfterTap(root);
      console.log(`Visit Flow: after tapping outlet card, visible texts: ${afterTapTexts.slice(0, 30).join(' | ')}`);
      throw new Error(`Start Visit action was not found within the "${outlet}" outlet card, and tapping the card did not open Outlet Details.`);
    }
    if (!startVisit.isEnabled) {
      throw new Error(`Start Visit action is disabled within the "${outlet}" outlet card.`);
    }
    // Tap through the Locator API rather than a raw coordinate pair: find the on-screen "Start Visit"
    // occurrence whose current bounds match the one identified above for this outlet's card, then let
    // the locator resolve and tap its own dynamically-computed center.
    const startVisitLocatorsForOutlet = await this.screen.getByText('Start Visit', { exact: true }).all();
    let matchedStartVisitLocator = startVisitLocatorsForOutlet[0];
    let matchedStartVisitDistance = Number.POSITIVE_INFINITY;
    for (const locatorCandidate of startVisitLocatorsForOutlet) {
      const box = await locatorCandidate.boundingBox().catch(() => undefined);
      if (!box) continue;
      const distance = Math.abs(box.y - startVisit.bounds.y) + Math.abs(box.x - startVisit.bounds.x);
      if (distance < matchedStartVisitDistance) {
        matchedStartVisitDistance = distance;
        matchedStartVisitLocator = locatorCandidate;
      }
    }
    if (matchedStartVisitLocator) {
      await matchedStartVisitLocator.tap().catch(() => undefined);
    }
    const outletPage = this.screen.getByText(/Outlet Details|Outlet Summary/i);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await outletPage.isVisible({ timeout: 5_000 }).catch(() => false)) {
        return;
      }
      const retryStartVisit = this.screen.getByText('Start Visit', { exact: true })
        .or(this.screen.getByLabel('Start Visit'));
      if (await retryStartVisit.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await retryStartVisit.tap();
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Tapping Start Visit for "${outlet}" did not open Outlet Details.`);
  }

  async readOutletCoordinates(): Promise<{ latitude: number; longitude: number }> {
    const nodes = await this.screen.viewTree();
    const texts: string[] = [];
    const collect = (node: (typeof nodes)[number]): void => {
      const text = (node.text ?? node.label ?? '').trim();
      if (node.isVisible && text) {
        texts.push(text);
      }
      for (const child of node.children) {
        collect(child);
      }
    };
    for (const node of nodes) {
      collect(node);
    }
    const coordinates = texts.flatMap((text) => [
      ...text.matchAll(/(-?\d+(?:\.\d+)?)\s*°\s*([NSEW])/gi),
    ]);
    const latitudeMatch = coordinates.find((match) => /[NS]/i.test(match[2]));
    const longitudeMatch = coordinates.find((match) => /[EW]/i.test(match[2]));
    const latitude = latitudeMatch ? Number(latitudeMatch[1]) * (/S/i.test(latitudeMatch[2]) ? -1 : 1) : undefined;
    const longitude = longitudeMatch ? Number(longitudeMatch[1]) * (/W/i.test(longitudeMatch[2]) ? -1 : 1) : undefined;
    if (latitude === undefined || longitude === undefined) {
      throw new Error('Outlet Details did not expose latitude and longitude for location mocking.');
    }
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new Error(`Outlet Details exposed invalid coordinates: ${latitude}, ${longitude}.`);
    }
    return { latitude, longitude };
  }

  async readSavedOutletCoordinates(): Promise<{ latitude: number; longitude: number }> {
    return this.readOutletCoordinates();
  }

  async logLocationUi(stage: string): Promise<void> {
    const nodes = await this.screen.viewTree();
    const values: string[] = [];
    const collect = (node: (typeof nodes)[number]): void => {
      const value = (node.text ?? node.label ?? '').trim();
      if (
        node.isVisible
        && value
        && (/checking your location|within range|move within|away|start visit|latitude|longitude|°\s*[NSEW]/i.test(value))
      ) {
        values.push(value);
      }
      for (const child of node.children) {
        collect(child);
      }
    };
    for (const node of nodes) {
      collect(node);
    }
    const startVisit = this.screen.getByText('Start Visit', { exact: true })
      .or(this.screen.getByLabel('Start Visit'))
      .or(this.screen.getByText(/Start Visit/i));
    const enabled = await startVisit.isEnabled({ timeout: 500 }).catch(() => false);
    console.log(`Visit Flow ${stage} location UI: ${[...new Set(values)].join(' | ') || 'no location details exposed'}; Start Visit enabled=${enabled}`);
  }

  async getGeofenceState(): Promise<'inside' | 'outside' | 'unknown'> {
    const inRange = this.screen.getByText(
      /within range|inside the geofence|in range|location verified|ready to visit/i,
    );
    if (await inRange.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const text = await inRange.getText().catch(() => '');
      if (!/away|outside|move within|farther than/i.test(text)) {
        return 'inside';
      }
    }

    const outside = this.screen.getByText(
      /You are\s+[\d,.]+\s*(?:m|km)\s+away|move within 100m|outside the geofence|farther than 100m/i,
    );
    if (await outside.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const text = await outside.getText().catch(() => '');
      if (/move within 100m|outside the geofence|farther than 100m/i.test(text)) {
        return 'outside';
      }
      const match = text.match(/You are\s+([\d,.]+)\s*(m|km)\s+away/i);
      if (match) {
        const meters = Number(match[1].replace(/,/g, '')) * (match[2].toLowerCase() === 'km' ? 1000 : 1);
        return meters <= 100 ? 'inside' : 'outside';
      }
    }

    return 'unknown';
  }

  async isCurrentlyWithinGeofence(): Promise<boolean> {
    return (await this.getGeofenceState()) === 'inside';
  }

  async ensureGeofenceState(
    outlet: string,
    desired: 'inside' | 'outside',
  ): Promise<void> {
    let state = await this.getGeofenceState();
    if (state === 'unknown') {
      await this.refreshLocationUi(outlet);
      state = await this.getGeofenceState();
    }

    if (state !== desired) {
      const coordinates = await this.readSavedOutletCoordinates();
      const target = desired === 'inside'
        ? coordinates
        : {
          latitude: Math.max(-89.9, Math.min(89.9, coordinates.latitude + 0.01)),
          longitude: coordinates.longitude,
        };
      console.log(
        `Visit Flow: current geofence state=${state}; desired=${desired}; `
        + `mocking GPS to ${target.latitude}, ${target.longitude}.`,
      );
      const { mockDeviceLocation } = await import('./login.page.js');
      await mockDeviceLocation(target.latitude, target.longitude);
      await this.refreshLocationUi(outlet);
    } else {
      console.log(`Visit Flow: current geofence state=${state} matches desired=${desired}; no GPS mock needed.`);
    }

    const finalState = await this.getGeofenceState();
    if (finalState !== desired) {
      throw new Error(`Expected geofence state "${desired}" for "${outlet}", but observed "${finalState}".`);
    }
  }

  async setGeofenceDistance(outlet: string, distanceMeters: number, bearingDegrees = 0): Promise<void> {
    const coordinates = await this.readSavedOutletCoordinates();
    const earthRadius = 6_371_000;
    const bearing = bearingDegrees * Math.PI / 180;
    const angularDistance = distanceMeters / earthRadius;
    const latitude = coordinates.latitude * Math.PI / 180;
    const longitude = coordinates.longitude * Math.PI / 180;
    const targetLatitude = Math.asin(
      Math.sin(latitude) * Math.cos(angularDistance)
      + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const targetLongitude = longitude + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(targetLatitude),
    );
    const target = {
      latitude: targetLatitude * 180 / Math.PI,
      longitude: targetLongitude * 180 / Math.PI,
    };

    console.log(`Visit Flow: mocking deterministic ${distanceMeters}m location for "${outlet}" at ${target.latitude}, ${target.longitude}`);
    await mockDeviceLocation(target.latitude, target.longitude);
    await this.refreshLocationUi(outlet);
  }

  async ensureGeofenceDistance(outlet: string, distanceMeters: number, bearingDegrees = 0): Promise<void> {
    await this.setGeofenceDistance(outlet, distanceMeters, bearingDegrees);
    // Require an explicit outside-geofence message here -- "within range" was previously accepted too,
    // which meant a failed/delayed GPS mock (device still reporting "within range") would silently
    // pass this check instead of surfacing the real problem.
    await expect(this.screen.getByText(/You are\s+[\d,.]+\s*(?:m|km)\s+away|Move within 100m|outside the geofence|farther than 100m/i))
      .toBeVisible({ timeout: 15_000 });
  }

  async refreshLocationUi(outlet?: string): Promise<void> {
    const outletDetails = this.screen.getByText(/Outlet Details|Outlet Summary/i);
    if (!(await outletDetails.isVisible({ timeout: 2_000 }).catch(() => false))) {
      throw new Error('Refresh requested outside Outlet Details; refusing to navigate away from the current app screen.');
    }

    if (!outlet) {
      throw new Error('Refresh requires the current outlet name so the same outlet can be reopened.');
    }

    const hasLocationState = async (): Promise<boolean> => {
      const tree = await this.screen.viewTree();
      const values: string[] = [];
      const collect = (node: (typeof tree)[number]): void => {
        const value = (node.text ?? node.label ?? '').trim();
        if (node.isVisible && value && (
          /checking your location|you are\s+[\d,.]+\s*(?:m|km)\s+away|within range|in range|location verified|ready to visit/i.test(value)
        )) {
          values.push(value);
        }
        for (const child of node.children) collect(child);
      };
      for (const root of tree) collect(root);
      return values.length > 0;
    };

    console.log(`Visit Flow: pulling down to refresh Outlet Details location state for "${outlet}".`);
    await this.screen.swipe('down', { distance: 350, duration: 600 }).catch(() => undefined);
    // Give the app time to settle after the gesture before checking anything, then confirm we are
    // still on Outlet Details (a swipe on this device can occasionally background the whole app).
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const stillOnOutletDetails = await outletDetails.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!stillOnOutletDetails) {
      console.log(`Visit Flow: pull-down left Outlet Details for "${outlet}"; reopening the outlet instead of retrying the swipe.`);
      await this.returnToOutletList(outlet);
      await this.openOutlet(outlet);
    }

    for (let attempt = 0; attempt < 10 && !(await hasLocationState()); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!(await hasLocationState())) {
      console.log(`Visit Flow: location state was not rendered after the pull-down refresh for "${outlet}"; keeping the current Outlet Details screen.`);
    }
  }

  async expectStartVisitEnabled(enabled: boolean): Promise<void> {
    await expect(this.screen.getByText(/Outlet Details|Outlet Summary/i)).toBeVisible({ timeout: 10_000 });
    const checkingLocation = this.screen.getByText(/Checking your location/i);
    if (enabled) {
      await expect(checkingLocation).toBeHidden({ timeout: 30_000 });
    }
    const startVisit = this.screen.getByText('Start Visit', { exact: true })
      .or(this.screen.getByLabel('Start Visit'))
      .or(this.screen.getByText(/Start Visit/i));
    await expect(startVisit).toBeVisible({ timeout: 10_000 });
    if (enabled) {
      await expect(startVisit).toBeEnabled({ timeout: 10_000 });
    } else {
      await expect(startVisit).toBeDisabled({ timeout: 10_000 });
    }
  }

  async expectStartVisitDisabledBelowDistanceWarning(): Promise<void> {
    await expect(this.screen.getByText(/Outlet Details|Outlet Summary/i)).toBeVisible({ timeout: 10_000 });
    const checkingLocation = this.screen.getByText(/Checking your location/i);
    const distanceWarning = this.screen.getByText(
      /You are\s+[\d,.]+\s*(?:m|km)\s+away|Move within 100m|outside the geofence|farther than 100m/i,
    );

    await expect(distanceWarning).toBeVisible({ timeout: 15_000 });
    await expect(checkingLocation).toBeHidden({ timeout: 15_000 });
    const startVisit = this.screen.getByText('Start Visit', { exact: true });
    await expect(startVisit).toBeVisible({ timeout: 10_000 });

    await startVisit.tap();
    await expect(this.screen.getByText(/Outlet Details|Outlet Summary/i)).toBeVisible({ timeout: 5_000 });
    await expect(distanceWarning).toBeVisible({ timeout: 5_000 });
    await expect(this.screen.getByText(/Visit Checklist|Brand Availability|Impactful Visibility/i)).toBeHidden({
      timeout: 5_000,
    });
  }

  async expectDistanceMessage(expectedPattern: RegExp): Promise<void> {
    await expect(this.screen.getByText(expectedPattern)).toBeVisible({ timeout: 10_000 });
  }

  async expectInRangeLocationStatus(): Promise<void> {
    const status = this.screen.getByText(
      /you are in|within range|inside the geofence|in range|location verified|ready to visit/i,
    );
    const distance = this.screen.getByText(/You are\s+[\d,.]+\s*(?:m|km)\s+away/i);
    const startVisit = this.screen.getByText('Start Visit', { exact: true })
      .or(this.screen.getByLabel('Start Visit'));
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (await status.isVisible({ timeout: 1_000 }).catch(() => false)) {
        const statusText = await status.getText();
        if (!/away|outside|move within|farther than/i.test(statusText)) {
          console.log(`Visit Flow: confirmed in-range location status: ${statusText}`);
          return;
        }
      }
      if (await distance.isVisible({ timeout: 500 }).catch(() => false)) {
        const distanceText = await distance.getText();
        const match = distanceText.match(/You are\s+([\d,.]+)\s*(m|km)\s+away/i);
        if (match) {
          const value = Number(match[1].replace(/,/g, '')) * (match[2].toLowerCase() === 'km' ? 1000 : 1);
          if (value <= 100) {
            console.log(`Visit Flow: confirmed in-range distance: ${distanceText}`);
            return;
          }
        }
      }
      const checking = this.screen.getByText(/Checking your location/i);
      if (
        attempt >= 5
        && !(await checking.isVisible({ timeout: 200 }).catch(() => false))
        && await startVisit.isEnabled({ timeout: 500 }).catch(() => false)
      ) {
        console.log('Visit Flow: automatic reopen refresh completed; Start Visit is enabled.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Outlet Details did not render an in-range status or a distance of 100m or less after reopening.');
  }

  async expectLocationCorrectionPending(): Promise<void> {
    await expect(this.screen.getByText(
      /Location update is pending approval\.\s*You may start this visit once;\s*another location request cannot be raised until it is approved\./i,
    )).toBeVisible({ timeout: 10_000 });
  }

  async submitLocationCorrectionRequest(reason: string): Promise<{ latitude: number; longitude: number }> {
    const coordinates = await this.readOutletCoordinates();
    const updateLocation = this.screen.getByText(/Update Outlet Location|Request Location Correction/i);
    await expect(updateLocation).toBeVisible({ timeout: 10_000 });
    await updateLocation.tap();

    const recaptureLocation = this.screen.getByText(/Re-?capture Location|Capture (?:Current|Actual) Location|Use Current Location/i);
    await expect(recaptureLocation).toBeVisible({ timeout: 10_000 });
    await recaptureLocation.tap();

    const reasonFields = [
      this.screen.getByPlaceholder('Explain why the location update is needed...'),
      this.screen.getByPlaceholder('Enter reason'),
      this.screen.getByPlaceholder('Reason'),
      this.screen.getByPlaceholder('Enter comments'),
      this.screen.getByPlaceholder('Comments'),
      this.screen.getByLabel('Reason'),
      this.screen.getByLabel('Comments'),
      this.screen.getByType('android.widget.EditText'),
      this.screen.getByType('EditText'),
    ];
    let filledReason = false;
    for (const reasonField of reasonFields) {
      if (await reasonField.isVisible({ timeout: 500 }).catch(() => false)) {
        try {
          await reasonField.fill(reason);
          filledReason = true;
          break;
        } catch {
          // Try the native type locator below.
        }
      }
    }
    if (!filledReason) {
      for (const inputType of ['edittext', 'textinput', 'textarea', 'input']) {
        const textInputs = this.screen.getByType(inputType);
        const inputCount = await textInputs.count();
        for (let index = 0; index < inputCount; index += 1) {
          const input = textInputs.nth(index);
          if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
            await input.fill(reason);
            filledReason = true;
            break;
          }
        }
        if (filledReason) {
          break;
        }
      }
    }
    if (!filledReason) {
      const nodes = await this.screen.viewTree();
      const visibleControls: string[] = [];
      const collectVisible = (node: (typeof nodes)[number]): void => {
        if (node.isVisible) {
          visibleControls.push(`${node.type}:${node.text ?? node.label ?? node.placeholder ?? node.resourceId ?? '(unnamed)'}`);
        }
        for (const child of node.children) {
          collectVisible(child);
        }
      };
      for (const root of nodes) {
        collectVisible(root);
      }
      throw new Error(`Location correction reason/comments field was not visible. Visible controls: ${visibleControls.join(' | ')}`);
    }

    const submit = this.screen.getByText(/Send for Approval|Submit for Approval/i);
    await expect(submit).toBeVisible({ timeout: 10_000 });
    await submit.tap();
    return coordinates;
  }

  async expectLocationCorrectionUnavailable(): Promise<void> {
    const updateLocation = this.screen.getByText(/Update Outlet Location|Request Location Correction/i);
    await expect(updateLocation).toBeHidden({ timeout: 10_000 });
  }

  async expectClosureRequestBlocksVisit(): Promise<void> {
    await expect(this.screen.getByText(
      /pending closure|closure request|no further actions|sent for approval|pending approval|closed:\s*pending/i,
    )).toBeVisible({ timeout: 10_000 });
    const startVisit = this.screen.getByText('Start Visit', { exact: true })
      .or(this.screen.getByLabel('Start Visit'));
    await expect(startVisit).toBeHidden({ timeout: 10_000 }).catch(async () => {
      await expect(startVisit).toBeDisabled({ timeout: 10_000 });
    });
  }

  async reopenOutletAndVerifyClosurePending(outlet: string): Promise<void> {
    const navigationAction = this.screen.getByText(
      /Go to (?:MJP|Today's Plan|Outlets)|Back to (?:MJP|Today's Plan|Outlets)|View Today's Plan/i,
    );
    const todaysPlanTile = this.screen.getByText("Today's Plan", { exact: true })
      .or(this.screen.getByText('Today’s Plan', { exact: true }))
      .or(this.screen.getByText(/Today's Plan/i));
    const outletVisible = async (): Promise<boolean> => (
      await this.screen.getByText(outlet, { exact: true }).isVisible({ timeout: 1_000 }).catch(() => false)
    );

    if (await outletVisible()) {
      // Already on a screen showing this outlet's card; nothing further to navigate.
    } else if (await navigationAction.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await navigationAction.tap();
    } else if (await todaysPlanTile.isVisible({ timeout: 2_000 }).catch(() => false)) {
      // Submitting the closure request typically returns straight to Home; open Today's Plan (the
      // Home quick-nav tile) rather than pressing BACK, which can trigger the Exit App confirmation
      // when Home has no screen above it to go back to.
      console.log('Visit Flow: closure submitted; navigating Home -> Today\'s Plan to reopen the outlet.');
      await todaysPlanTile.tap();
    } else {
      await this.screen.pressButton('BACK');
      await dismissExitPromptIfVisible(this.screen);
    }

    await expect(this.screen.getByText(outlet, { exact: true })).toBeVisible({ timeout: 15_000 });
    await this.openOutlet(outlet);

    await expect(this.screen.getByText(
      /Outlet Marked as Closed|closure request|sent for approval|pending approval|outlet closure is pending|No further actions can be performed/i,
    )).toBeVisible({ timeout: 15_000 });
    await this.expectClosureRequestBlocksVisit();
  }


  async submitClosureRequest(): Promise<void> {
    const markAsClosed = this.screen.getByText(/Mark as Closed/i);
    await expect(markAsClosed).toBeVisible({ timeout: 10_000 });
    await expect(markAsClosed).toBeEnabled({ timeout: 10_000 });
    await markAsClosed.tap();

    const reportClosed = this.screen.getByText(/Report Outlet Closed|Report as Closed|Outlet Closed/i);
    await expect(reportClosed).toBeVisible({ timeout: 10_000 });
    await reportClosed.tap();

    // Match only the dropdown's own placeholder text ("Choose reason for closure"), not the static
    // "Select Reason *" field label above it -- both used to satisfy a broader regex, and since that
    // label isn't tappable, tapping it (picked first in tree order) silently failed to open the dropdown.
    const reasonSelector = this.screen.getByText('Choose reason for closure', { exact: true })
      .or(this.screen.getByText(/Choose (?:a )?reason for closure/i))
      .or(this.screen.getByLabel('Select reason'))
      .or(this.screen.getByLabel('Select a reason'))
      .or(this.screen.getByLabel('Choose reason'))
      .or(this.screen.getByLabel('Closure reason'));
    await expect(reasonSelector).toBeVisible({ timeout: 10_000 });

    const reasonPatterns = [
      /^Permanently Closed$/i,
      /^Business Shut Down$/i,
      /^License Cancelled$/i,
      /^Merged with Another Outlet$/i,
      /^Other$/i,
    ];

    const anyReasonVisible = async (): Promise<boolean> => {
      const nodes = await this.screen.viewTree();
      let found = false;
      const collect = (node: (typeof nodes)[number]): void => {
        const text = (node.text ?? node.label ?? '').trim();
        if (node.isVisible && reasonPatterns.some((pattern) => pattern.test(text))) {
          found = true;
        }
        for (const child of node.children) collect(child);
      };
      for (const root of nodes) collect(root);
      return found;
    };

    // The dropdown can take a beat to render, and on some renders the options list sits just below the
    // visible viewport, so tap the selector, wait, and nudge the sheet up a little if nothing showed yet.
    for (let attempt = 0; attempt < 3 && !(await anyReasonVisible()); attempt += 1) {
      await reasonSelector.tap();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (!(await anyReasonVisible())) {
        await this.screen.swipe('up', { distance: 250, duration: 400 }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const tapReasonByBounds = async (pattern: RegExp): Promise<boolean> => {
      // Match via the same live locator we tap, instead of a separate raw view-tree scan feeding
      // hand-computed pixel coordinates — this keeps selection and tapping using one dynamic source of
      // truth (the driver's own text/label matching) instead of two.
      const optionLocators = await this.screen.getByText(pattern).all();
      if (optionLocators.length === 0) {
        return false;
      }
      let largestLocator = optionLocators[0];
      let largestArea = -1;
      for (const locatorCandidate of optionLocators) {
        const box = await locatorCandidate.boundingBox().catch(() => undefined);
        if (!box) continue;
        const area = box.width * box.height;
        if (area > largestArea) {
          largestArea = area;
          largestLocator = locatorCandidate;
        }
      }
      if (largestArea < 0) {
        return false;
      }
      await largestLocator.tap().catch(() => undefined);
      return true;
    };

    let selectedReason = false;
    for (const reason of reasonPatterns) {
      if (await tapReasonByBounds(reason)) {
        selectedReason = true;
        break;
      }
    }
    if (!selectedReason) {
      const nodes = await this.screen.viewTree();
      const optionTexts: string[] = [];
      const excluded = /^(Reporting for|Select|Choose|Reason|Remarks|Provide details|Photo Evidence|Capture Photo|Approval Workflow|This request|Submit|Cancel|Close|Confirm)/i;
      const collectOptions = (node: (typeof nodes)[number]): void => {
        const text = (node.text ?? node.label ?? '').trim();
        if (
          node.isVisible
          && text
          && !excluded.test(text)
          && text.length < 80
          && /permanently closed|business shut down|license cancelled|merged with another outlet|other/i.test(text)
        ) {
          optionTexts.push(text);
        }
        for (const child of node.children) {
          collectOptions(child);
        }
      };
      for (const root of nodes) {
        collectOptions(root);
      }
      const firstOption = [...new Set(optionTexts)][0];
      if (firstOption) {
        await tapReasonByBounds(new RegExp(firstOption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        selectedReason = true;
      }
    }
    if (!selectedReason) {
      const nodes = await this.screen.viewTree();
      const visibleOptions: string[] = [];
      const collectVisibleOptions = (node: (typeof nodes)[number]): void => {
        const text = (node.text ?? node.label ?? '').trim();
        if (
          node.isVisible
          && text
          && /closed|shut down|cancelled|merged|other/i.test(text)
          && !/choose reason|select reason/i.test(text)
        ) {
          visibleOptions.push(text);
        }
        for (const child of node.children) {
          collectVisibleOptions(child);
        }
      };
      for (const root of nodes) {
        collectVisibleOptions(root);
      }
      throw new Error(
        `Closure reason dropdown opened but no selectable reason was visible. `
        + `Visible options: ${[...new Set(visibleOptions)].join(' | ') || 'none'}`,
      );
    }
    await expect(this.screen.getByText('Choose reason for closure', { exact: true }))
      .toBeHidden({ timeout: 5_000 });

    const capturePhoto = this.screen.getByText(/Capture\s+Photo/i)
      .or(this.screen.getByLabel('Capture Photo'))
      .or(this.screen.getByLabel('Capture photo'))
      .or(this.screen.getByRole('button', { name: /Capture\s+Photo/i }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await capturePhoto.isVisible({ timeout: 1_000 }).catch(() => false)) {
        break;
      }
      await this.screen.swipe('up', { distance: 450, duration: 500 });
    }
    await expect(capturePhoto).toBeVisible({ timeout: 10_000 });
    await capturePhoto.tap();

    const submit = this.screen.getByText(/Submit Request|Submit Closure|Confirm/i);
    await expect(submit).toBeVisible({ timeout: 120_000 });
    await submit.tap();

    const confirmation = this.screen.getByText(
      /Outlet Marked as Closed|closure request.*submitted|request submitted successfully|successfully submitted|pending approval|No further actions can be performed/i,
    );
    const ok = this.screen.getByText('OK', { exact: true })
      .or(this.screen.getByLabel('OK'));
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (await confirmation.isVisible({ timeout: 500 }).catch(() => false)) {
        if (await ok.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await ok.tap();
        }
        return;
      }
      if (await ok.isVisible({ timeout: 500 }).catch(() => false)) {
        await ok.tap();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const nodes = await this.screen.viewTree();
    const visibleText: string[] = [];
    const collectVisibleText = (node: (typeof nodes)[number]): void => {
      const text = (node.text ?? node.label ?? '').trim();
      if (node.isVisible && text) {
        visibleText.push(text);
      }
      for (const child of node.children) {
        collectVisibleText(child);
      }
    };
    for (const root of nodes) {
      collectVisibleText(root);
    }
    throw new Error(`Closure request submission did not show confirmation. Visible UI: ${[...new Set(visibleText)].join(' | ')}`);
  }

  async expectMarkAsClosedEnabled(enabled: boolean): Promise<void> {
    const markAsClosed = this.screen.getByText(/Mark as Closed/i);
    if (enabled) {
      await expect(markAsClosed).toBeVisible({ timeout: 10_000 });
      await expect(markAsClosed).toBeEnabled({ timeout: 10_000 });
    } else {
      if (!(await markAsClosed.isVisible({ timeout: 2_000 }).catch(() => false))) {
        await expect(markAsClosed).toBeHidden({ timeout: 10_000 });
        return;
      }
      if (!(await markAsClosed.isEnabled({ timeout: 2_000 }).catch(() => false))) {
        await expect(markAsClosed).toBeDisabled({ timeout: 10_000 });
        return;
      }
      await markAsClosed.tap();
      await expect(this.screen.getByText(/Report Outlet Closed|Report as Closed|Outlet Closed/i))
        .toBeHidden({ timeout: 5_000 });
      await expect(this.screen.getByText(/Outlet Details|Outlet Summary/i)).toBeVisible({ timeout: 5_000 });
      await expect(this.screen.getByText(
        /You are\s+[\d,.]+\s*(?:m|km)\s+away|Move within 100m|outside the geofence|farther than 100m/i,
      )).toBeVisible({ timeout: 5_000 });
    }
  }

  async openVisitTasks(): Promise<void> {
    const startVisit = this.screen.getByText('Start Visit', { exact: true });
    await expect(startVisit).toBeVisible({ timeout: 10_000 });
    await expect(startVisit).toBeEnabled({ timeout: 10_000 });
    await startVisit.tap();
    await this.completeVisitCaptureStep();
    const taskScreen = this.screen.getByText(
      /Visit Checklist|Brand Availability|Impactful Visibility|TIL Marketing Elements|Sell-in Order Discussion|CSM Gift Distribution|Spot Sales|Report Issue/i,
    );
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await taskScreen.isVisible({ timeout: 500 }).catch(() => false)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Starting the visit did not open a task or visit form screen.');
  }

  async startVisitAndOpenVisitTasks(): Promise<string> {
    const outlet = this.activeOutlet ?? await this.openAnyOutletFromList(undefined, false, true);
    if (!outlet) {
      throw new Error('No Start Visit eligible outlet is available for the Visit Tasks flow.');
    }
    await this.ensureGeofenceState(outlet, 'inside');
    await this.openVisitTasks();
    await expect(this.screen.getByText(/Visit Checklist|Brand Availability|Impactful Visibility/i)).toBeVisible({ timeout: 15_000 });
    console.log(`Visit Flow: Visit Tasks opened for "${outlet}"`);
    return outlet;
  }

  async ensureVisitTasks(): Promise<void> {
    if (await this.isVisitTaskListVisible()) {
      return;
    }

    const resume = this.screen.getByText('Resume', { exact: true })
      .or(this.screen.getByLabel('Resume'));
    if (await resume.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await resume.tap();
      await this.expectVisitTaskList();
      return;
    }

    await this.startVisitAndOpenVisitTasks();
    await this.expectVisitTaskList();
  }

  private async isVisitTaskListVisible(): Promise<boolean> {
    const nodes = await this.screen.viewTree();
    const taskNames = new Set([
      'Brand Availability',
      'Impactful Visibility',
      'TIL Marketing Elements',
      'Sell-in Order Discussion',
      'CSM Gift Distribution',
      'Spot Sales',
    ]);
    const visibleTasks = new Set<string>();
    let startActions = 0;
    let completionTallyVisible = false;
    const collect = (node: (typeof nodes)[number]): void => {
      const value = (node.text ?? node.label ?? '').trim();
      if (node.isVisible && taskNames.has(value)) visibleTasks.add(value);
      if (node.isVisible && value === 'Start') startActions += 1;
      if (node.isVisible && /\d+\s+of\s+\d+\s+Completed/i.test(value)) completionTallyVisible = true;
      for (const child of node.children) collect(child);
    };
    for (const root of nodes) collect(root);
    return completionTallyVisible || (visibleTasks.size >= 2 && startActions > 0);
  }

  private async expectVisitTaskList(): Promise<void> {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (await this.isVisitTaskListVisible()) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Visit Tasks list did not become visible.');
  }

  async resumeActiveVisit(): Promise<void> {
    const taskScreen = this.screen.getByText(
      /Visit Checklist|Brand Availability|Impactful Visibility|TIL Marketing Elements|Sell-in Order Discussion|CSM Gift Distribution|Spot Sales|Report Issue/i,
    );
    if (await taskScreen.isVisible({ timeout: 1_000 }).catch(() => false)) {
      return;
    }

    const resume = this.screen.getByText('Resume', { exact: true })
      .or(this.screen.getByLabel('Resume'));
    await expect(resume).toBeVisible({ timeout: 10_000 });
    await resume.tap();
    await expect(taskScreen).toBeVisible({ timeout: 15_000 });
  }

  async closeActiveVisitIfPresent(): Promise<void> {
    const resume = this.screen.getByText('Resume', { exact: true })
      .or(this.screen.getByLabel('Resume'));
    const activeVisit = this.screen.getByText('ACTIVE VISIT', { exact: true });
    const hasResume = await resume.isVisible({ timeout: 1_000 }).catch(() => false);
    if (!hasResume && !(await activeVisit.isVisible({ timeout: 1_000 }).catch(() => false))) {
      return;
    }

    if (hasResume) {
      await resume.tap();
    }
    const noTasksMessage = this.screen.getByText(/No tasks completed/i);
    const remarksCandidates = [
      this.screen.getByPlaceholder('Add any remarks about this visit. Required if no tasks are completed.'),
      this.screen.getByRole('textfield', { name: 'Add any remarks about this visit. Required if no tasks are completed.' }),
      this.screen.getByRole('textfield'),
    ];
    if (await noTasksMessage.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const debugNodes = await this.screen.viewTree();
      const debugValues: string[] = [];
      const collectDebug = (node: (typeof debugNodes)[number]): void => {
        const value = `${node.type ?? ''}|${node.text ?? ''}|${node.label ?? ''}|${node.placeholder ?? ''}`.trim();
        if (node.isVisible && value) debugValues.push(value);
        for (const child of node.children) collectDebug(child);
      };
      for (const node of debugNodes) collectDebug(node);
      console.log(`Visit Flow active-visit controls: ${debugValues.filter((value) => /remark|comment|end visit|textfield|edittext/i.test(value)).join(' || ')}`);
      let remark: Locator | undefined;
      for (const candidate of remarksCandidates) {
        if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
          remark = candidate;
          break;
        }
      }
      if (!remark) {
        const nodes = await this.screen.viewTree();
        const indexes = new Map<string, number>();
        let remarkType: string | undefined;
        let remarkIndex = -1;
        const collectRemark = (node: (typeof nodes)[number]): void => {
          const type = (node.type ?? '').toLowerCase();
          const index = indexes.get(type) ?? 0;
          indexes.set(type, index + 1);
          const hint = `${node.placeholder ?? ''} ${node.text ?? ''} ${node.label ?? ''}`.toLowerCase();
          if (!remarkType && node.isVisible && /remark|comment/.test(hint) && /edittext|textfield|input/.test(type)) {
            remarkType = type;
            remarkIndex = index;
          }
          for (const child of node.children) collectRemark(child);
        };
        for (const node of nodes) collectRemark(node);
        if (remarkType && remarkIndex >= 0) {
          remark = this.screen.getByType(remarkType).nth(remarkIndex);
        }
      }
      if (remark) {
        const remarkText = await noTasksMessage.getText();
        await remark.fill(remarkText);
        if ((await remark.getValue().catch(() => '')).length === 0) {
          throw new Error('Active visit remarks field did not retain the required cleanup remark.');
        }
        await this.screen.getByText('Ready to check out?', { exact: true }).tap().catch(() => undefined);
      }
    }
    const end = this.screen.getByText('End Visit', { exact: true })
      .or(this.screen.getByRole('button', { name: 'End Visit' }))
      .or(this.screen.getByText(/Complete Visit|Finish Visit/i));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await end.isVisible({ timeout: 1_000 }).catch(() => false)) {
        // Several "End Visit" occurrences can be visible at once (e.g. behind a card); prefer the
        // locator with the largest rendered area over the first en­countered, which is typically the
        // primary action rather than an incidental smaller label.
        const endLocators = await this.screen.getByText('End Visit', { exact: true }).all();
        let largestEndLocator: (typeof endLocators)[number] | undefined;
        let largestArea = -1;
        for (const locatorCandidate of endLocators) {
          const box = await locatorCandidate.boundingBox().catch(() => undefined);
          if (!box) continue;
          const area = box.width * box.height;
          if (area > largestArea) {
            largestArea = area;
            largestEndLocator = locatorCandidate;
          }
        }
        if (largestEndLocator) {
          await largestEndLocator.tap().catch(() => undefined);
        } else {
          await end.tap();
        }
        break;
      }
      await this.screen.swipe('up', { distance: 450, duration: 600 });
    }

    if (await noTasksMessage.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const postEndRemark = this.screen.getByPlaceholder('Add any remarks about this visit. Required if no tasks are completed.')
        .or(this.screen.getByRole('textfield', { name: 'Add any remarks about this visit. Required if no tasks are completed.' }))
        .or(this.screen.getByRole('textfield'));
      if (await postEndRemark.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await postEndRemark.fill(await noTasksMessage.getText());
        await end.tap().catch(() => undefined);
      }
    }

    const confirmation = this.screen.getByText('Confirm & End Visit', { exact: true })
      .or(this.screen.getByText('Confirm', { exact: true }))
      .or(this.screen.getByText('Submit', { exact: true }))
      .or(this.screen.getByText('Yes', { exact: true }));
    if (await confirmation.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmation.tap();
    }
    if (await activeVisit.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await end.tap().catch(() => undefined);
      const retryConfirmation = this.screen.getByText(/Confirm.*End Visit|Submit|Yes/i);
      if (await retryConfirmation.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await retryConfirmation.tap();
      }
    }
    const home = this.screen.getByText('MJP', { exact: true })
      .or(this.screen.getByText('Check out for the day', { exact: true }))
      .or(this.screen.getByText('Check in for the day', { exact: true }))
      .or(this.screen.getByText(/Awaiting Sync/i));
    if (!(await home.isVisible({ timeout: 15_000 }).catch(() => false))) {
      const nodes = await this.screen.viewTree();
      const visibleText: string[] = [];
      const collect = (node: (typeof nodes)[number]): void => {
        const value = (node.text ?? node.label ?? '').trim();
        if (node.isVisible && value) visibleText.push(value);
        for (const child of node.children) collect(child);
      };
      for (const node of nodes) collect(node);
      throw new Error(`Active visit cleanup did not return to Home or Awaiting Sync. Visible UI: ${[...new Set(visibleText)].join(' | ')}`);
    }
  }

  async tapStartVisitAndVerify(): Promise<void> {
    await expect(this.screen.getByText(/Outlet Details|Outlet Summary/i)).toBeVisible({ timeout: 10_000 });
    const startVisit = this.screen.getByText('Start Visit', { exact: true })
      .or(this.screen.getByLabel('Start Visit'));
    await expect(startVisit).toBeVisible({ timeout: 10_000 });
    await expect(startVisit).toBeEnabled({ timeout: 10_000 });
    await startVisit.tap();
    await expect(
      this.screen.getByText(/Capture(?: Selfie| Photo)?|Take (?:Selfie|Photo)|Selfie/i)
        .or(this.screen.getByLabel('Capture'))
        .or(this.screen.getByText(/Visit Checklist|Brand Availability|Impactful Visibility/i)),
    ).toBeVisible({ timeout: 15_000 });
    console.log('Visit Flow: Start Visit opened the visit capture/task flow.');
  }

  async completeVisitCaptureStep(): Promise<void> {
    const capture = this.screen.getByText(/Capture(?: Selfie| Photo)?|Take (?:Selfie|Photo)|Selfie/i)
      .or(this.screen.getByLabel('Capture'));
    await expect(capture).toBeVisible({ timeout: 15_000 });
    await capture.tap();
    await captureVisitPhoto(this.screen);

    const continueButton = this.screen.getByText('Continue', { exact: true })
      .or(this.screen.getByRole('button', { name: 'Continue' }))
      .or(this.screen.getByLabel('Continue'));
    if (await continueButton.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await expect(continueButton).toBeEnabled({ timeout: 10_000 });
      await continueButton.tap();
      console.log('Visit Flow: selfie/photo captured and Continue tapped.');
      return;
    }

    const next = this.screen.getByText(/Next|Continue|Proceed/i)
      .or(this.screen.getByRole('button', { name: /Next|Continue|Proceed/i }))
      .or(this.screen.getByLabel('Next'))
      .or(this.screen.getByLabel('Proceed'));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await next.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await expect(next).toBeEnabled({ timeout: 10_000 });
        await next.tap();
        console.log('Visit Flow: selfie/photo captured and next visit-form action tapped.');
        return;
      }
      await this.screen.swipe('up', { distance: 450, duration: 600 });
    }

    const markAsClosed = this.screen.getByText(/Mark as Closed/i);
    if (await markAsClosed.isVisible({ timeout: 1_000 }).catch(() => false)) {
      console.log('Visit Flow: selfie/photo capture returned directly to the form with Mark as Closed visible.');
      return;
    }
    throw new Error('No post-capture Next, Continue, Proceed, or Mark as Closed action was visible.');
  }

  async openReportIssue(): Promise<void> {
    // Unlike every other visit task, "Report Issue" is a standalone link row below the 6-task
    // checklist (no "Start" button, no completion tally impact) — tapping the row itself navigates
    // to it, so this must not go through startVisitTask()'s Start-button-matching logic.
    const reportIssue = this.screen.getByText('Report Issue', { exact: true });
    if (!(await reportIssue.isVisible({ timeout: 500 }).catch(() => false))) {
      await reportIssue.scrollIntoViewIfNeeded({ maxSwipes: 8 });
    }
    await expect(reportIssue).toBeVisible({ timeout: 10_000 });

    // Resolve the live locator through the view tree, mirroring startVisitTask()'s approach: a
    // one-off "isVisible"/"toBeVisible" snapshot can go stale by the time tap() re-resolves the
    // locator (the row can re-layout right after the async task list finishes loading), so pick the
    // smallest matching node's live bounds and tap the nearest matching locator instead of relying
    // on a single ambiguous locator resolution.
    const nodes = await this.screen.viewTree();
    type ViewNode = (typeof nodes)[number];
    const reportIssueNodes: ViewNode[] = [];
    const collect = (node: ViewNode): void => {
      const value = (node.text ?? node.label ?? '').trim();
      if (node.isVisible && value === 'Report Issue') reportIssueNodes.push(node);
      for (const child of node.children) collect(child);
    };
    for (const root of nodes) collect(root);
    const targetNode = reportIssueNodes.sort(
      (left, right) => (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height),
    )[0];
    if (!targetNode) {
      await reportIssue.tap();
      return;
    }
    const candidates = await this.screen.getByText('Report Issue', { exact: true }).all();
    let matched = candidates[0];
    let matchedDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const box = await candidate.boundingBox().catch(() => undefined);
      if (!box) continue;
      const distance = Math.abs(box.y - targetNode.bounds.y) + Math.abs(box.x - targetNode.bounds.x);
      if (distance < matchedDistance) {
        matchedDistance = distance;
        matched = candidate;
      }
    }
    await (matched ?? reportIssue).tap();
  }

  async completeRequiredVisitTasks(): Promise<void> {
    const complete = this.screen.getByText(/Complete Visit|Finish Visit|End Visit/i)
      .or(this.screen.getByRole('button', { name: /Complete Visit|Finish Visit|End Visit/i }));
    if (await complete.isVisible({ timeout: 2_000 }).catch(() => false)) {
      return;
    }
    console.log('Visit Flow: no explicit required-task completion control is exposed yet');
  }

  async endVisit(): Promise<void> {
    const end = this.screen.getByText(/End Visit|Complete Visit|Finish Visit/i)
      .or(this.screen.getByRole('button', { name: /End Visit|Complete Visit|Finish Visit/i }));
    await expect(end).toBeVisible({ timeout: 10_000 });
    await end.tap();

    // Ending a visit with no tasks completed requires a mandatory remark (per the app's own label:
    // "Add any remarks about this visit. Required if no tasks are completed."); fill it if present
    // rather than assuming the visit ends immediately, since a blank required field silently blocks
    // the subsequent confirm tap otherwise.
    const remarks = this.screen.getByRole('textfield', { name: /remark/i })
      .or(this.screen.getByPlaceholder('Type your comment/remark here...'));
    if (await remarks.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await remarks.tap();
      await remarks.fill('Automated test - end of visit remarks');
      // Dismiss the keyboard (it otherwise stays open and covers the End Visit button below) by
      // tapping a static heading rather than pressing BACK, which risks navigating away instead.
      const heading = this.screen.getByText('Visit Remarks / Comments', { exact: true });
      if (await heading.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await heading.tap().catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // A "Yes/Confirm/OK/Submit" dialog can appear as a system confirm before the actual "End Visit"
    // submit button; check for it here, but deliberately exclude "End Visit" itself from this
    // regex — that exact button is tapped explicitly below, and matching it here as well causes a
    // premature double-tap that can navigate past the intended screen.
    const confirmCandidates = [
      this.screen.getByRole('button', { name: /^(Yes|Confirm|OK|Submit)$/i }),
      this.screen.getByText(/^(Yes|Confirm|OK|Submit)$/i),
    ];
    for (const confirm of confirmCandidates) {
      if (await confirm.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await confirm.tap();
        break;
      }
    }

    // With remarks now filled, the same "End Visit" action from this Visit Details/End Visit screen
    // must be tapped again to actually submit — the very first tap above only navigated here from
    // the Visit Tasks list, it did not submit anything. This screen's own header title also reads
    // "End Visit" (an ambiguous plain-text match alongside the real button), so resolve the actual
    // button through the view tree — picking the lowest ("greatest Y") matching node, mirroring the
    // node-matching approach used by openReportIssue() — rather than a single ambiguous locator.
    const submitNodes = await this.screen.viewTree();
    type ViewNode = (typeof submitNodes)[number];
    const endVisitTextNodes: ViewNode[] = [];
    const collectEndVisit = (node: ViewNode): void => {
      const value = (node.text ?? node.label ?? '').trim();
      if (node.isVisible && value === 'End Visit') endVisitTextNodes.push(node);
      for (const child of node.children) collectEndVisit(child);
    };
    for (const root of submitNodes) collectEndVisit(root);
    const submitTargetNode = endVisitTextNodes.sort((left, right) => right.bounds.y - left.bounds.y)[0];
    if (!submitTargetNode) {
      throw new Error('Final End Visit submit action was not exposed after entering visit remarks.');
    }
    const submitCandidates = await this.screen.getByText('End Visit', { exact: true }).all();
    let submitMatched = submitCandidates[0];
    let submitMatchedDistance = Number.POSITIVE_INFINITY;
    for (const candidate of submitCandidates) {
      const box = await candidate.boundingBox().catch(() => undefined);
      if (!box) continue;
      const distance = Math.abs(box.y - submitTargetNode.bounds.y) + Math.abs(box.x - submitTargetNode.bounds.x);
      if (distance < submitMatchedDistance) {
        submitMatchedDistance = distance;
        submitMatched = candidate;
      }
    }
    if (!submitMatched) {
      throw new Error('Final End Visit submit locator could not be resolved.');
    }
    await submitMatched.scrollIntoViewIfNeeded({ maxSwipes: 4 });
    await submitMatched.tap();

    // A second confirmation dialog can appear after the actual submit tap; dismiss it the same way.
    for (const confirm of confirmCandidates) {
      if (await confirm.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await confirm.tap();
        break;
      }
    }
  }

  async continueJourneyAfterEndVisit(): Promise<void> {
    const journey = this.screen.getByText(
      /^(?:Continue )?Journey$|Go to Journey|Back to Journey/i,
    ).or(this.screen.getByRole('button', {
      name: /^(?:Continue )?Journey$|Go to Journey|Back to Journey/i,
    }));
    await expect(journey).toBeVisible({ timeout: 15_000 });
    await journey.tap();
    await expect(
      this.screen.getByText(/Awaiting Sync|item awaiting sync|Tap to open/i),
    ).toBeVisible({ timeout: 15_000 });
  }

  async expectHelpAndSupport(): Promise<void> {
    await expect(this.screen.getByText(/Help & Support/i)).toBeVisible({ timeout: 10_000 });
    const nodes = await this.screen.viewTree();
    const contactDetails: string[] = [];
    const collectContactDetails = (node: (typeof nodes)[number]): void => {
      const value = node.text?.trim() || node.label?.trim() || node.value?.trim();
      if (node.isVisible && value && (/support|help|@|email|phone|call|contact|\+?\d[\d\s()-]{6,}/i.test(value))) {
        contactDetails.push(value);
      }
      for (const child of node.children) {
        collectContactDetails(child);
      }
    };
    for (const root of nodes) {
      collectContactDetails(root);
    }
    const uniqueDetails = [...new Set(contactDetails)];
    const actualContactDetails = uniqueDetails.filter((value) => /@|\+?\d[\d\s()-]{6,}|email|phone|call/i.test(value));
    expect(actualContactDetails.length).toBeGreaterThan(0);
    console.log(`TC-055 Help & Support contact card: ${actualContactDetails.join(' | ')}`);
  }

  async openGiftDistribution(): Promise<void> {
    // Consistent with every other visit task: tap the task's own "Start" action rather than the task
    // label text, since tapping the label directly is unreliable (mirrors the outlet-card tap bug).
    await this.startVisitTask('CSM Gift Distribution');
  }

  async startVisitTask(taskName: string): Promise<void> {
    const task = this.screen.getByText(taskName, { exact: true });
    if (!(await task.isVisible({ timeout: 500 }).catch(() => false))) {
      await task.scrollIntoViewIfNeeded({ maxSwipes: 8 });
    }
    const nodes = await this.screen.viewTree();
    type ViewNode = (typeof nodes)[number];
    const taskNodes: ViewNode[] = [];
    const startNodes: ViewNode[] = [];
    const collect = (node: ViewNode): void => {
      const value = (node.text ?? node.label ?? '').trim();
      if (node.isVisible && value === taskName) taskNodes.push(node);
      if (node.isVisible && value === 'Start') startNodes.push(node);
      for (const child of node.children) collect(child);
    };
    for (const root of nodes) collect(root);
    const taskNode = taskNodes.sort(
      (left, right) => (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height),
    )[0];
    if (!taskNode) {
      throw new Error(`Task "${taskName}" was visible but not exposed in the view tree.`);
    }
    const taskCenterY = taskNode.bounds.y + taskNode.bounds.height / 2;
    const start = startNodes
      .filter((node) => Math.abs(node.bounds.y + node.bounds.height / 2 - taskCenterY) < 180)
      .sort((left, right) => Math.abs(left.bounds.y - taskNode.bounds.y) - Math.abs(right.bounds.y - taskNode.bounds.y))[0];
    if (!start) {
      throw new Error(`Start action for task "${taskName}" was not found.`);
    }
    // Tap through the Locator API: find the "Start" occurrence whose bounds match the one identified
    // above as belonging to this task's row, then let the locator resolve and tap its own live center
    // rather than a coordinate pair captured from this one-off view-tree snapshot.
    const startLocators = await this.screen.getByText('Start', { exact: true }).all();
    let matchedStartLocator = startLocators[0];
    let matchedStartDistance = Number.POSITIVE_INFINITY;
    for (const locatorCandidate of startLocators) {
      const box = await locatorCandidate.boundingBox().catch(() => undefined);
      if (!box) continue;
      const distance = Math.abs(box.y - start.bounds.y) + Math.abs(box.x - start.bounds.x);
      if (distance < matchedStartDistance) {
        matchedStartDistance = distance;
        matchedStartLocator = locatorCandidate;
      }
    }
    if (!matchedStartLocator) {
      throw new Error(`Start action for task "${taskName}" was not found.`);
    }
    await matchedStartLocator.tap();
    console.log(`Visit Flow: tapped Start for task "${taskName}".`);
  }

  async expectGiftDistribution(): Promise<void> {
    await expect(this.screen.getByText(/Gift Inventory|Gift Distribution/i)).toBeVisible({ timeout: 10_000 });
    await expect(this.screen.getByText(/Recipient Name/i)).toBeVisible({ timeout: 10_000 });
    await expect(this.screen.getByText(/Phone No|Phone Number/i)).toBeVisible({ timeout: 10_000 });
    await expect(this.screen.getByText(/Handover photo|Handover Image/i)).toBeVisible({ timeout: 10_000 });
  }

  async expectGiftRecipientFieldRequirements(): Promise<void> {
    const requiredLabels = [
      this.screen.getByText(/Recipient Name\s*\*/i),
      this.screen.getByText(/Phone (?:No|Number)\s*\*/i),
      this.screen.getByText(/Handover (?:photo|Image)\s*\*/i),
    ];
    for (const label of requiredLabels) {
      await expect(label).toBeVisible({ timeout: 10_000 });
    }
    const pan = this.screen.getByText(/^PAN(?: Number)?(?:\s*\(Optional\))?$/i);
    await expect(pan).toBeVisible({ timeout: 10_000 });
    const panText = await pan.getText();
    expect(/\*/.test(panText)).toBe(false);
  }

  async getTaskCount(): Promise<number> {
    const taskNames = new Set([
      'Brand Availability',
      'Impactful Visibility',
      'TIL Marketing Elements',
      'Sell-in Order Discussion',
      'CSM Gift Distribution',
      'Spot Sales',
      'Report Issue',
    ]);
    const nodes = await this.screen.viewTree();
    const visibleTaskNames = new Set<string>();
    const collect = (node: (typeof nodes)[number]): void => {
      const value = (node.text ?? node.label ?? '').trim();
      if (node.isVisible && taskNames.has(value)) {
        visibleTaskNames.add(value);
      }
      for (const child of node.children) collect(child);
    };
    for (const root of nodes) collect(root);
    return visibleTaskNames.size;
  }

  async getConfiguredVisitTaskNames(): Promise<string[]> {
    const knownTaskNames = new Set([
      'Brand Availability',
      'Impactful Visibility',
      'TIL Marketing Elements',
      'Sell-in Order Discussion',
      'CSM Gift Distribution',
      'Spot Sales',
    ]);
    const observed = new Set<string>();
    for (let reset = 0; reset < 4; reset += 1) {
      await this.screen.swipe('down', { distance: 700, duration: 250 });
    }
    for (let viewport = 0; viewport < 9; viewport += 1) {
      const nodes = await this.screen.viewTree();
      const collect = (node: (typeof nodes)[number]): void => {
        const value = (node.text ?? node.label ?? '').trim();
        if (node.isVisible && knownTaskNames.has(value)) observed.add(value);
        for (const child of node.children) collect(child);
      };
      for (const root of nodes) collect(root);
      await this.screen.swipe('up', { distance: 650, duration: 250 });
    }
    return [...observed];
  }

  // Reads the "X of Y Completed" tally shown at the top of the Visit Tasks list (distinct from
  // getTaskCount() above, which counts visible task-name labels rather than this completion count).
  async getCompletedTaskTally(): Promise<{ completed: number; total: number } | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const nodes = await this.screen.viewTree();
      let match: RegExpMatchArray | null = null;
      const collect = (node: (typeof nodes)[number]): void => {
        const value = (node.text ?? node.label ?? '').trim();
        if (!match && node.isVisible) {
          const found = value.match(/(\d+)\s+of\s+(\d+)\s+Completed/i);
          if (found) match = found;
        }
        for (const child of node.children) collect(child);
      };
      for (const root of nodes) collect(root);
      if (match) {
        return { completed: Number(match[1]), total: Number(match[2]) };
      }
      await this.screen.swipe('down', { distance: 600, duration: 300 });
    }
    return null;
  }

  // Expands every brand row on the current task screen that still shows an outstanding "0/N"
  // required-fields badge, then fills every narrow stock/facing EditText this reveals. Wide fields
  // (the "Search brands/SKU" box) are skipped by width, matching the real field's much narrower
  // shape rather than relying on any hardcoded brand/SKU name.
  //
  // Each field's own "Min norm: N" label (read live from the view tree, not hardcoded) determines
  // what value is entered: entering anything below a field's min norm triggers a live "Below norm"
  // warning banner that reflows the layout mid-keystroke and can hang the input driver, so every
  // field is filled with a value comfortably above its own min norm (or `fallbackValue` when no min
  // norm is shown for that field, e.g. optional SKUs).
  async fillAllRequiredTaskFields(fallbackValue: number): Promise<number> {
    let filled = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const nodes = await this.screen.viewTree();
      type ViewNode = (typeof nodes)[number];
      const editTextNodes: ViewNode[] = [];
      const minNormNodes: ViewNode[] = [];
      const collectFieldNodes = (node: ViewNode): void => {
        const type = (node.type ?? '').toLowerCase();
        const text = (node.text ?? node.label ?? '').trim();
        if (node.isVisible && type.includes('edittext')) editTextNodes.push(node);
        if (node.isVisible && /^min norm:\s*\d+/i.test(text)) minNormNodes.push(node);
        for (const child of node.children) collectFieldNodes(child);
      };
      for (const root of nodes) collectFieldNodes(root);

      let targetNode: ViewNode | null = null;
      for (const node of editTextNodes) {
        // The "Search brands/SKU" box spans nearly the full screen width; every real stock/facing
        // field is a narrow box docked to the right of its row, so this reliably excludes it.
        if (node.bounds.width > 500) continue;
        const currentValue = (node.value ?? node.text ?? '').toString().trim();
        if (!currentValue) {
          targetNode = node;
          break;
        }
      }

      if (targetNode) {
        // Find the "Min norm: N" label vertically closest to this field (same row) to pick a safe
        // fill value; fields without a nearby min-norm label (e.g. optional SKUs) use the fallback.
        let safeValue = fallbackValue;
        let closestDistance = Number.POSITIVE_INFINITY;
        for (const minNormNode of minNormNodes) {
          const distance = Math.abs(minNormNode.bounds.y - targetNode.bounds.y);
          if (distance < closestDistance) {
            closestDistance = distance;
            const match = (minNormNode.text ?? minNormNode.label ?? '').match(/(\d+)/);
            if (match) safeValue = Math.max(fallbackValue, Number(match[1]) + 20);
          }
        }

        const sameTypeNodes = editTextNodes.filter((n) => n.type === targetNode!.type);
        const indexAmongSameType = sameTypeNodes.indexOf(targetNode);
        const fieldLocator = this.screen.getByType(targetNode.type).nth(indexAmongSameType);
        try {
          await fieldLocator.tap();
          await fieldLocator.fill(String(safeValue));
          // Not re-reading the value back here: right after fill(), the keyboard's "Done"/IME
          // action can trigger a layout re-render (e.g. a "Norm met" label appearing) that briefly
          // detaches the underlying view, making an immediate getValue() call unreliable even
          // though the fill itself succeeded. A successful fill() call is trusted on its own.
          filled += 1;
        } catch (error) {
          console.log(`Visit Flow: could not fill a required task field: ${(error as Error).message}`);
        }
        // Dismiss the keyboard by tapping a static heading rather than pressing BACK: a BACK press
        // here is ambiguous — if the keyboard has already auto-dismissed, it exits the task screen
        // instead (surfacing the "Leave task?" dialog prematurely).
        const heading = this.screen.getByText(/SKUs captured/i);
        if (await heading.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await heading.tap().catch(() => undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      // No empty field is visible right now; expand the next outstanding required brand row.
      let requiredSummary: string | null = null;
      const collect = (node: ViewNode): void => {
        if (requiredSummary) return;
        const text = (node.text ?? node.label ?? '').trim();
        if (node.isVisible && /,\s*0\/\d+$/.test(text)) {
          requiredSummary = text;
        }
        for (const child of node.children) collect(child);
      };
      for (const root of nodes) collect(root);
      if (!requiredSummary) break;

      const row = this.screen.getByText(requiredSummary, { exact: true });
      await row.scrollIntoViewIfNeeded({ maxSwipes: 6 }).catch(() => undefined);
      if (!(await row.isVisible({ timeout: 1_500 }).catch(() => false))) break;
      await row.tap();
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return filled;
  }

  // Navigates back out of the currently open task (via its "Go back" control, or the device BACK
  // button as a fallback) and, if the app's "Leave task?" confirmation appears, taps SAVE to persist
  // any entered data as a draft. Returns whether SAVE succeeded (i.e. no "Missing required fields"
  // banner blocked it) or whether the app already returned to the Visit Tasks list.
  async leaveTaskAndSave(): Promise<'saved' | 'blocked' | 'no-dialog'> {
    const goBack = this.screen.getByText('Go back', { exact: true }).or(this.screen.getByLabel('Go back'));
    if (await goBack.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await goBack.tap();
    } else {
      await this.screen.pressButton('BACK').catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const save = this.screen.getByText('SAVE', { exact: true });
    if (!(await save.isVisible({ timeout: 2_500 }).catch(() => false))) {
      return 'no-dialog';
    }
    await save.tap();
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const missingFields = this.screen.getByText(/Missing required fields/i);
    if (await missingFields.isVisible({ timeout: 2_000 }).catch(() => false)) {
      return 'blocked';
    }
    return 'saved';
  }

  async expectTaskNamesVisible(taskNames: string[]): Promise<void> {
    const expectedNames = new Set(taskNames);
    const observedNames = new Set<string>();
    for (let reset = 0; reset < 4; reset += 1) {
      await this.screen.swipe('down', { distance: 700, duration: 250 });
    }
    for (let viewport = 0; viewport < 9 && observedNames.size < expectedNames.size; viewport += 1) {
      const nodes = await this.screen.viewTree();
      const collect = (node: (typeof nodes)[number]): void => {
        const value = (node.text ?? node.label ?? '').trim();
        if (node.isVisible && expectedNames.has(value)) observedNames.add(value);
        for (const child of node.children) collect(child);
      };
      for (const root of nodes) collect(root);
      if (observedNames.size < expectedNames.size) {
        await this.screen.swipe('up', { distance: 650, duration: 250 });
      }
    }
    const missing = taskNames.filter((taskName) => !observedNames.has(taskName));
    if (missing.length > 0) {
      throw new Error(`Visit task list is missing: ${missing.join(', ')}.`);
    }
  }

  // Scans the current view tree for a visible text-input node whose hint text does not look like a
  // search/brand/SKU box, and returns a locator for it (by type+index) or null if none is found. This
  // is safer than a bare `getByRole('textfield')` fallback, which can match the "Search brands/SKU"
  // box at the top of the screen instead of the actual stock/facing field.
  private async findNumericFieldExcludingSearch(): Promise<Locator | null> {
    const nodes = await this.screen.viewTree();
    const numericInputIndexes = new Map<string, number>();
    const typeCounts = new Map<string, number>();
    const collectInputs = (node: (typeof nodes)[number]): void => {
      const type = (node.type ?? '').toLowerCase();
      if (node.isVisible && /edittext|textinput|textfield|input/.test(type)) {
        const index = typeCounts.get(type) ?? 0;
        typeCounts.set(type, index + 1);
        const hint = `${node.placeholder ?? ''} ${node.text ?? ''} ${node.label ?? ''}`.trim();
        if (!/search|brand|sku/i.test(hint)) {
          numericInputIndexes.set(type, index);
        }
      }
      for (const child of node.children) collectInputs(child);
    };
    for (const root of nodes) collectInputs(root);
    for (const [type, index] of numericInputIndexes) {
      const field = this.screen.getByType(type).nth(index);
      if (await field.isVisible({ timeout: 500 }).catch(() => false)) {
        return field;
      }
    }
    return null;
  }

  async getNumericField(): Promise<Locator> {
    if (this.numericField) {
      return this.numericField;
    }
    const fields = [
      this.screen.getByRole('textfield', { name: '0' }),
      // `getByRole`'s `name` matches the accessible label exactly, and this app appends a required-
      // field marker (e.g. "Current stock *"), so a regex is used instead of a plain string.
      this.screen.getByRole('textfield', { name: /Current stock/i }),
      this.screen.getByRole('textfield', { name: /Bottle facing count/i }),
      this.screen.getByPlaceholder('Current stock'),
      this.screen.getByPlaceholder('Bottle facing count'),
    ];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      for (const field of fields) {
        if (await field.isVisible({ timeout: 500 }).catch(() => false)) {
          this.numericField = field;
          return field;
        }
      }
      if (attempt === 0) {
        await this.expandNumericTaskCard();
      }
      for (const field of fields) {
        if (await field.isVisible({ timeout: 500 }).catch(() => false)) {
          this.numericField = field;
          return field;
        }
      }
      const field = await this.findNumericFieldExcludingSearch();
      if (field) {
        this.numericField = field;
        return field;
      }
      await this.screen.swipe('up', { distance: 420, duration: 600 });
    }
    throw new Error('No stock or facing numeric field was visible in the visit task form.');
  }

  private async getSkuCandidateNames(): Promise<string[]> {
    const nodes = await this.screen.viewTree();
    type ViewNode = (typeof nodes)[number];
    const excludedLabels = new Set([
      'Brand Availability',
      'Impactful Visibility',
      'TIL Marketing Elements',
      'Sell-in Order Discussion',
      'CSM Gift Distribution',
      'Spot Sales',
      'Report Issue',
      'Start',
      'Save',
      'Next',
      'Search',
      'No tasks completed.',
      'Task Progress',
      'Ready to check out?',
      'Visit Remarks / Comments',
      'Add any remarks about this visit. Required if no tasks are completed.',
      'Submit Task',
    ]);
    const candidates: ViewNode[] = [];
    const collect = (node: ViewNode): void => {
      const value = (node.text ?? node.label ?? '').trim();
      if (
        node.isVisible &&
        value &&
        node.children.length === 0 &&
        !excludedLabels.has(value) &&
        !/^(current stock|bottle facing count|search brands?|sku|start|save|cancel|next|back|close)$/i.test(value) &&
        !/^(?:code|status|type|category|outlet)\s*:/i.test(value) &&
        value !== this.activeOutlet &&
        value !== value.toUpperCase() &&
        node.bounds.width >= 300 &&
        node.bounds.height >= 40 &&
        !/^(?:\d{1,2}:\d{2}|wifi signal|battery charging|recents|home|back|edge panels|go back|own brands|competitor brands|whisky|gin|\d+\/\d+ skus captured|\d+ skus)$/i.test(value) &&
        !/notification|signal full|percent|charging/i.test(value) &&
        !/^\d+(?:\.\d+)?$/.test(value) &&
        node.bounds.width > 0 &&
        node.bounds.height > 0
      ) {
        candidates.push(node);
      }
      for (const child of node.children) collect(child);
    };
    for (const root of nodes) collect(root);

    return candidates
      .filter((candidate) => {
        const value = (candidate.text ?? candidate.label ?? '').trim();
        return !/^(?:\d+\/\d+|\d+\s*SKUs?)$/i.test(value)
          && !/^(?:own brands|competitor brands|whisky|gin)$/i.test(value);
      })
      .sort((left, right) => left.bounds.y - right.bounds.y)
      .map((candidate) => (candidate.text ?? candidate.label ?? '').trim());
  }

  private async openSkuAndEnterValue(skuName: string, value: number): Promise<string | null> {
    const sku = this.screen.getByText(skuName, { exact: true });
    if (!(await sku.isVisible({ timeout: 1_000 }).catch(() => false))) return null;
    console.log(`Visit Flow: opening SKU "${skuName}" to enter value ${value}.`);
    await this.withWatchdog(`tap SKU "${skuName}"`, () => sku.tap());
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.screen.swipe('up', { distance: 350, duration: 500 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Deliberately avoid getNumericField()'s deep expandNumericTaskCard() fallback here: that helper
    // scans and taps through every SKU looking for *any* field, which can silently return a field
    // belonging to a different SKU than the one just opened and leave the view in an unexpected place.
    // A direct, immediate check against the known field candidates keeps this scoped to this SKU only.
    // `getByRole`'s `name` matches the accessible label exactly, and this app appends a required-field
    // marker (e.g. "Current stock *"), so regexes are used. The last resort is a viewTree scan that
    // excludes search/brand/SKU boxes (a bare `getByRole('textfield')` would otherwise match the
    // "Search brands/SKU" box at the top of the screen instead of the actual stock/facing field).
    const fieldCandidates = [
      this.screen.getByRole('textfield', { name: /Current stock/i }),
      this.screen.getByRole('textfield', { name: /Bottle facing count/i }),
      this.screen.getByPlaceholder('Current stock'),
      this.screen.getByPlaceholder('Bottle facing count'),
    ];
    // The card can take a moment to render after tapping/scrolling, so poll for up to ~4s rather than
    // giving up after a single 500ms check (a single fast check was silently skipping SKUs whose card
    // simply hadn't finished expanding yet).
    let field: Locator | null = null;
    for (let attempt = 0; attempt < 8 && !field; attempt += 1) {
      for (const candidate of fieldCandidates) {
        if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
          field = candidate;
          break;
        }
      }
      if (!field) {
        field = await this.findNumericFieldExcludingSearch();
      }
    }
    if (!field) {
      console.log(`Visit Flow: no numeric field was exposed for SKU "${skuName}"; skipping.`);
      return null;
    }
    try {
      await field.tap();
      await field.clear();
      await field.fill(String(value));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const retained = await field.getValue().catch(() => null);
      console.log(`Visit Flow: SKU "${skuName}" field now reads "${retained}" after entering ${value}.`);
      return retained;
    } catch (error) {
      console.log(`Visit Flow: could not set value for SKU "${skuName}" (${(error as Error).message}); skipping.`);
      return null;
    }
  }

  // Enters `testValue` (the value under test, which may be out-of-range) into EVERY mandatory
  // stock/facing field across all SKU cards, then attempts to submit the task and complete the visit.
  // There is no inline validation banner in this app: per the confirmed spec, an out-of-range value is
  // only a defect if a field retains it verbatim (not clamped) AND the visit still completes with it —
  // the caller checks both signals. Returns the retained value for every SKU so a partial
  // acceptance/rejection (e.g. one SKU silently clamped, another not) is visible in the evidence.
  async fillAllMandatorySkusThenAttemptCompletion(
    testValue: number,
  ): Promise<{ visitCompleted: boolean; retainedValue: string | null; retainedValuesBySku: Record<string, string | null> }> {
    // Re-scan the live SKU list right before opening it, rather than relying on one stale snapshot
    // taken before any cards were expanded — expanding one SKU's card can shift what else is visible
    // on screen, so a name captured up-front may no longer be where (or what) the UI shows by the time
    // its turn comes around.
    const skuNames = await this.getSkuCandidateNames();
    if (skuNames.length === 0) {
      throw new Error('No SKUs were found to fill mandatory values for.');
    }
    console.log(`Visit Flow: found ${skuNames.length} SKU(s) to fill: ${skuNames.join(', ')}`);

    const retainedValuesBySku: Record<string, string | null> = {};
    for (const skuName of skuNames) {
      retainedValuesBySku[skuName] = await this.openSkuAndEnterValue(skuName, testValue);
    }
    const retainedValue = retainedValuesBySku[skuNames[0]] ?? null;

    const submitCandidates = [
      this.screen.getByText('Submit Task', { exact: true }),
      this.screen.getByText('Save', { exact: true }),
      this.screen.getByRole('button', { name: /Submit Task|Save/i }),
    ];
    for (const submit of submitCandidates) {
      if (await submit.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await submit.tap();
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Try to complete the visit as a normal user would; if the out-of-range value was rejected, the
    // app is expected to either block this step (End Visit unavailable/error) or keep the visit open
    // instead of reaching the "Awaiting Sync" completed state. `endVisit()` throws if its control never
    // appears, which is itself valid evidence of rejection here, so treat that as "not completed" too.
    await this.completeRequiredVisitTasks();
    try {
      await this.endVisit();
    } catch (error) {
      console.log(`Visit Flow: End Visit was not reachable after entering value ${testValue} (${(error as Error).message}).`);
      return { visitCompleted: false, retainedValue, retainedValuesBySku };
    }
    const completed = await this.screen.getByText(/Awaiting Sync|item awaiting sync|Tap to open/i)
      .isVisible({ timeout: 8_000 }).catch(() => false);
    return { visitCompleted: completed, retainedValue, retainedValuesBySku };
  }

  private async expandNumericTaskCard(): Promise<void> {
    const skuCandidates = await this.getSkuCandidateNames();

    for (const value of skuCandidates) {
      const sku = this.screen.getByText(value, { exact: true });
      if (!(await sku.isVisible({ timeout: 300 }).catch(() => false))) continue;
      console.log(`Visit Flow: opening SKU "${value}" to expose stock/facing fields.`);
      await this.withWatchdog(`tap SKU "${value}"`, () => sku.tap());
      await this.screen.swipe('up', { distance: 350, duration: 500 }).catch(() => undefined);
      for (const field of [
        this.screen.getByRole('textfield', { name: '0' }),
        this.screen.getByRole('textfield', { name: /Current stock/i }),
        this.screen.getByRole('textfield', { name: /Bottle facing count/i }),
        this.screen.getByPlaceholder('Current stock'),
        this.screen.getByPlaceholder('Bottle facing count'),
      ]) {
        if (await field.isVisible({ timeout: 500 }).catch(() => false)) return;
      }
      if (await this.findNumericFieldExcludingSearch()) return;
      if (process.env.MW_DEBUG_SCREENSHOTS) {
        try {
          const buffer = await this.screen.screenshot();
          const fs = await import('node:fs');
          fs.writeFileSync(`debug-sku-${value.replace(/\W+/g, '_')}.png`, buffer);
          const nodes = await this.screen.viewTree();
          fs.writeFileSync(`debug-sku-${value.replace(/\W+/g, '_')}.json`, JSON.stringify(nodes, null, 2));
          console.log(`Visit Flow DEBUG: saved screenshot/viewTree for SKU "${value}".`);
        } catch (error) {
          console.log(`Visit Flow DEBUG: failed to save diagnostics (${(error as Error).message}).`);
        }
      }
    }
  }

  async enterNumericValue(value: number): Promise<void> {
    const field = await this.getNumericField();
    const expected = String(value);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await field.tap();
      await field.clear();
      await field.fill(expected);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const actual = await field.getValue().catch(() => '');
      const namedValue = this.screen.getByRole('textfield', { name: expected });
      if (actual === expected || await namedValue.isVisible({ timeout: 500 }).catch(() => false)) {
        this.numericField = field;
        return;
      }
    }
    // Out-of-range values (e.g. above the max or below zero) are expected to be rejected or clamped
    // by the app rather than retained verbatim; the caller (e.g. TC-043/044) verifies rejection via a
    // validation message instead of relying on this method to confirm the value was accepted.
    console.log(`Visit Flow: numeric field did not retain "${expected}" after entry; leaving verification to the caller.`);
    this.numericField = field;
  }

  async expectNumericValue(value: number): Promise<void> {
    const field = await this.getNumericField();
    await expect(field).toBeVisible({ timeout: 10_000 });
    const expected = String(value);
    const actual = await field.getValue().catch(() => '');
    if (actual === expected) {
      return;
    }
    await expect(this.screen.getByRole('textfield', { name: expected })).toBeVisible({ timeout: 10_000 });
  }

  async expectNumericValueRejected(value: number): Promise<void> {
    const field = await this.getNumericField();
    await expect(field).toBeVisible({ timeout: 10_000 });
    const retained = await field.getValue();
    expect(retained).not.toBe(String(value));
  }

  async expectGeofenceBoundaryStatus(distanceMeters: number): Promise<void> {
    const expectedState = distanceMeters > 100 ? 'outside' : 'inside';
    const state = await this.getGeofenceState();
    if (state !== expectedState) {
      throw new Error(
        `Expected ${distanceMeters}m to resolve as "${expectedState}", but the app reported "${state}".`,
      );
    }
    if (expectedState === 'inside') {
      await this.expectStartVisitEnabled(true);
    } else {
      await this.expectStartVisitDisabledBelowDistanceWarning();
    }
  }
}
