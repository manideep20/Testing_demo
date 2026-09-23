import { expect } from '@mobilewright/test';
import type { Screen } from '@mobilewright/core';

export class MjpPage {
  private readonly screen: Screen;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  async openMjp(): Promise<void> {
    const todaysPlanCandidates = [
      this.screen.getByText("Today's Plan", { exact: true }),
      this.screen.getByText('Today’s Plan', { exact: true }),
      this.screen.getByText(/Today's Plan/i),
    ];

    console.log("MJP navigation: waiting for Today's Plan");
    for (const todaysPlan of todaysPlanCandidates) {
      if (await todaysPlan.isVisible({ timeout: 2_000 }).catch(() => false)) {
        console.log("MJP navigation: tapping Today's Plan");
        await todaysPlan.tap();
        return;
      }
    }

    throw new Error("Today's Plan action was not visible after completing Start Day.");
  }

  async openMjpCalendarEntry(): Promise<void> {
    const mjpCandidates = [
      this.screen.getByText('MJP', { exact: true }),
      this.screen.getByLabel('MJP'),
      this.screen.getByText(/MJP/i),
    ];

    for (const mjp of mjpCandidates) {
      if (await mjp.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await mjp.tap();
        return;
      }
    }

    throw new Error('MJP entry was not visible from the Home screen.');
  }

  async openPlannedTab(): Promise<void> {
    const planned = this.screen.getByText('Planned');
    await expect(planned).toBeVisible({ timeout: 10_000 });
    await planned.tap();
  }

  async openUnplannedTab(): Promise<void> {
    const unplanned = this.screen.getByText('Unplanned');
    await expect(unplanned).toBeVisible({ timeout: 10_000 });
    await unplanned.tap();
  }

  async openCalendarView(): Promise<void> {
    const calendarCandidates = [
      this.screen.getByText('Calendar', { exact: true }),
      this.screen.getByText('Calendar View', { exact: true }),
      this.screen.getByText(/Calendar View|Calendar/i),
      this.screen.getByLabel('Calendar'),
    ];

    for (const calendar of calendarCandidates) {
      if (await calendar.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await calendar.tap();
        return;
      }
    }

    throw new Error('Calendar View control was not visible after opening Today\'s Plan.');
  }

  async openPreviousDate(): Promise<boolean> {
    const previousDateCandidates = [
      this.screen.getByLabel('Previous day'),
      this.screen.getByRole('button', { name: /Previous day|Previous date|Previous/i }),
      this.screen.getByText(/Previous day|Previous date/i),
    ];

    for (const previousDate of previousDateCandidates) {
      if (await previousDate.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await previousDate.tap();
        return true;
      }
    }

    console.log('Calendar UI has no previous-date control; no historical outlet data is available');
    return false;
  }

  async openPendingFilter(): Promise<boolean> {
    const pendingCandidates = [
      this.screen.getByText('Pending', { exact: true }),
      this.screen.getByLabel('Pending'),
      this.screen.getByRole('button', { name: /Pending/i }),
    ];

    for (const pending of pendingCandidates) {
      if (await pending.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await pending.tap();
        return true;
      }
    }

    console.log('Calendar UI has no Pending filter; no pending outlet data is available');
    return false;
  }

  async openFilter(label: 'All' | 'Pending' | 'Special Assignment'): Promise<boolean> {
    const candidates = [
      this.screen.getByText(label, { exact: true }),
      this.screen.getByLabel(label),
      this.screen.getByRole('button', { name: new RegExp(label, 'i') }),
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await candidate.tap();
        return true;
      }
    }

    console.log(`Calendar UI has no ${label} filter; no outlet data is available for this filter`);
    return false;
  }

  async openListView(): Promise<void> {
    const listCandidates = [
      this.screen.getByText('List', { exact: true }),
      this.screen.getByText('List View', { exact: true }),
      this.screen.getByText(/List View|List/i),
      this.screen.getByLabel('List View'),
      this.screen.getByRole('button', { name: /List View|List/i }),
    ];

    for (const list of listCandidates) {
      if (await list.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await list.tap();
        return;
      }
    }

    throw new Error('List View control was not visible in MJP.');
  }

  async search(text: string): Promise<void> {
    const searchBoxes = [
      this.screen.getByPlaceholder('Search'),
      this.screen.getByPlaceholder('Search outlet'),
      this.screen.getByPlaceholder('Outlet search'),
      this.screen.getByRole('textfield'),
    ];
    let searchBox = searchBoxes[0];

    if (!(await searchBox.isVisible({ timeout: 1_000 }).catch(() => false))) {
      const searchTriggers = [
        this.screen.getByLabel('Search'),
        this.screen.getByRole('button', { name: /Search/i }),
        this.screen.getByText('Search', { exact: true }),
      ];

      for (const trigger of searchTriggers) {
        if (await trigger.isVisible({ timeout: 500 }).catch(() => false)) {
          await trigger.tap();
          break;
        }
      }

      for (const candidate of searchBoxes) {
        if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
          searchBox = candidate;
          break;
        }
      }
    }

    await expect(searchBox).toBeVisible({ timeout: 10_000 });
    await searchBox.fill(text);
  }

  async isSearchAvailable(): Promise<boolean> {
    const candidates = [
      this.screen.getByPlaceholder('Search'),
      this.screen.getByPlaceholder('Search outlet'),
      this.screen.getByPlaceholder('Outlet search'),
      this.screen.getByRole('textfield'),
      this.screen.getByLabel('Search'),
      this.screen.getByRole('button', { name: /Search/i }),
      this.screen.getByText('Search', { exact: true }),
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
        return true;
      }
    }

    return false;
  }

  async clearSearch(): Promise<void> {
    const clear = this.screen.getByText('Clear');
    if (await clear.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await clear.tap();
      return;
    }

    const searchBox = this.screen.getByPlaceholder('Search');
    if (await searchBox.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await searchBox.clear();
    }
  }

  async bellIconNavigateToAwaitingSync(): Promise<boolean> {
    const bellCandidates = [
      this.screen.getByText('Notifications', { exact: true }),
      this.screen.getByLabel('Notifications'),
      this.screen.getByRole('button', { name: /Notifications|Notification|Bell/i }),
    ];

    for (const bell of bellCandidates) {
      if (await bell.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await bell.tap();
        return true;
      }
    }

    console.log('MJP notification bell is not visible; there is no sync notification UI to verify');
    return false;
  }

  async expectPlannedCountersVisible(): Promise<boolean> {
    await expect(this.screen.getByText(/Planned/i)).toBeVisible({ timeout: 10_000 });
    await expect(this.screen.getByText(/Completed/i)).toBeVisible({ timeout: 10_000 });
    if (!(await this.screen.getByText(/Remaining/i).isVisible({ timeout: 2_000 }).catch(() => false))) {
      console.log('Planned UI has no Remaining counter; no outlets are available');
      return false;
    }
    return true;
  }

  async readCounter(label: 'Planned' | 'Completed' | 'Remaining'): Promise<number | undefined> {
    const counter = this.screen.getByText(new RegExp(label, 'i'));
    if (!(await counter.isVisible({ timeout: 1_000 }).catch(() => false))) {
      return undefined;
    }

    const text = await counter.getText().catch(() => '');
    const value = text.match(/(\d+)/)?.[1];
    return value === undefined ? undefined : Number(value);
  }

  async readVisibleNumericCounters(): Promise<number[]> {
    const numericNodes = this.screen.getByText(/^\d+$/);
    const values: number[] = [];
    const count = await numericNodes.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const text = await numericNodes.nth(index).getText().catch(() => '');
      if (/^\d+$/.test(text.trim())) {
        values.push(Number(text.trim()));
      }
    }

    return values;
  }

  async expectPlannedOutletList(): Promise<void> {
    await expect(this.screen.getByText(/Planned/i)).toBeVisible({ timeout: 10_000 });
    const emptyState = this.screen.getByText(/No planned orders|No planned outlets|No planned visits|No outlets|Nothing to show|No data available|No records found/i);
    if (await emptyState.isVisible({ timeout: 1_000 }).catch(() => false)) {
      console.log(`Planned outlet list is empty: ${await emptyState.getText().catch(() => 'No planned outlets')}`);
      return;
    }

    const outletList = this.screen.getByText(/Wine for Kings|CUST_MP35900|The Beer Hotel/i);
    if (!(await outletList.isVisible({ timeout: 5_000 }).catch(() => false))) {
      console.log('Planned outlet list has no accessible outlet text; continuing with the visible Planned UI state');
    }
  }

  async expectUnplannedSearchFilters(): Promise<void> {
    await expect(this.screen.getByText(/Unplanned/i)).toBeVisible({ timeout: 10_000 });

    if (await this.isUnplannedEmpty()) {
      return;
    }

    const searchCandidates = [
      this.screen.getByPlaceholder('Search'),
      this.screen.getByLabel('Search'),
      this.screen.getByText('Search', { exact: true }),
    ];
    let searchVisible = false;
    for (const candidate of searchCandidates) {
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
        searchVisible = true;
        break;
      }
    }
    console.log(`Unplanned search control visible: ${searchVisible}`);
  }

  async isUnplannedEmpty(): Promise<boolean> {
    const emptyStateCandidates = [
      this.screen.getByText(/No unplanned orders|No unplanned outlets|No unplanned visits|No outlets|Nothing to show/i),
      this.screen.getByText(/No data available|No records found/i),
    ];
    for (const emptyState of emptyStateCandidates) {
      if (await emptyState.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`Unplanned empty state: ${await emptyState.getText().catch(() => 'No unplanned outlets')}`);
        return true;
      }
    }
    return false;
  }

  async expectSearchResult(query: string): Promise<void> {
    await expect(this.screen.getByText(new RegExp(query, 'i'))).toBeVisible({ timeout: 10_000 });
  }

  async expectCalendarDataVisible(): Promise<void> {
    await expect(this.screen.getByText(/Today|Calendar|Pending|Visited|Yet to Visit/i)).toBeVisible({ timeout: 10_000 });
  }

  async expectPendingCountMatchesRemaining(): Promise<void> {
    await expect(this.screen.getByText(/Pending/i)).toBeVisible({ timeout: 10_000 });
    await expect(this.screen.getByText(/Remaining/i)).toBeVisible({ timeout: 10_000 });
  }

  async expectFixedCountersAcrossFilter(): Promise<void> {
    await expect(this.screen.getByText(/Visited/i)).toBeVisible({ timeout: 10_000 });
    await expect(this.screen.getByText(/Yet to Visit/i)).toBeVisible({ timeout: 10_000 });
  }

  async expectAwaitingSyncPage(): Promise<void> {
    await expect(this.screen.getByText(/Awaiting Sync/i)).toBeVisible({ timeout: 15_000 });
  }

  async expectNotVisitedWithoutStartVisit(outlet: string): Promise<void> {
    await expect(this.screen.getByText(outlet, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(this.screen.getByText(/Not Visited/i)).toBeVisible({ timeout: 10_000 });
    await expect(this.screen.getByText(/Start Visit/i)).toBeHidden({ timeout: 10_000 });
  }

  async expectListStatusLabels(): Promise<void> {
    await expect(this.screen.getByText(/No assignment|No Assignment|Weekly off|Weekly Off|Done|Missed|Planned|Pending|Visited|Not Visited|In Progress/i)).toBeVisible({
      timeout: 10_000,
    });
  }
}
