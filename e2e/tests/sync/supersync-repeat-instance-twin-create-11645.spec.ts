import { test, expect } from '../../fixtures/supersync.fixture';
import {
  createTestUser,
  getSuperSyncConfig,
  createSimulatedClient,
  closeClient,
  waitForTask,
  getTaskTitleFromState,
  recordTaskTimeDelta,
  expectExactTaskTime,
  type SimulatedE2EClient,
} from '../../utils/supersync-helpers';
import { openRecurDialog, saveRecurDialog } from '../../utils/recurring-task-helpers';
import { getStoreSummary } from '../../utils/audit-error-paths-helpers';

/**
 * Bug: https://github.com/super-productivity/super-productivity/issues/11645
 *
 * A recurring task's instance for a day has a deterministic id
 * (`rpt_<cfgId>_<day>`). The phone creates today's instance, renames it and
 * tracks time on it. The desktop, asleep or closed meanwhile, creates the same
 * instance on its own before it syncs. Its bare Create is the newer op, so
 * whole-entity LWW used to pick it and its blank snapshot erased the phone's
 * title and tracked time on both devices.
 *
 * Both conflict directions: the phone's edits reach the server first (the
 * desktop resolves them as remote), or the desktop's bare Create does (the
 * phone resolves its pending edits as local).
 */

const DAY_16 = '2026-06-16';
const TRACKED_MS = 60_000;
// Each page has its own clock. The desktop wakes hours after the phone's
// edits, so its bare Create is the newer op, as in the report.
const PHONE_TIME = '00:05:00';
const DESKTOP_TIME = '08:00:00';

const currentInstance = (
  page: SimulatedE2EClient['page'],
  name: string,
): ReturnType<SimulatedE2EClient['page']['locator']> =>
  page.locator(`task:not(.isDone):not(.ng-animating):has-text("${name}")`).first();

/** Opens the task panel from the hover toolbar (as in the #9728 spec). */
const openTaskDetail = async (
  page: SimulatedE2EClient['page'],
  name: string,
): Promise<void> => {
  const task = page.locator(`task:has-text("${name}")`).first();
  await task.waitFor({ state: 'visible', timeout: 10000 });
  await task.locator('.first-line').first().hover();
  const showDetailBtn = page.getByRole('button', { name: 'Show/hide task panel' });
  await showDetailBtn.waitFor({ state: 'visible', timeout: 5000 });
  await showDetailBtn.click();
};

/**
 * Marks day 15's instance done, then moves the clock to `time` on day 16 so
 * the day-change effect creates day 16's instance. setSystemTime keeps the
 * clock moving, which the effect chain's debounceTime needs (#6230).
 */
const advanceToDay16 = async (
  client: SimulatedE2EClient,
  name: string,
  time: string,
): Promise<void> => {
  const prev = currentInstance(client.page, name);
  const prevId = await prev.getAttribute('data-task-id');
  await prev.locator('.first-line').first().focus();
  await prev.press('d');
  await expect
    .poll(() => client.page.locator(`task[data-task-id="${prevId}"].isDone`).count(), {
      timeout: 10000,
    })
    .toBeGreaterThan(0);

  await client.page.clock.setSystemTime(new Date(`${DAY_16}T${time}`));
  await client.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(currentInstance(client.page, name)).toBeVisible({ timeout: 60000 });
};

/**
 * Renames day 16's instance. Scoped to the undone row: day 15's done
 * instance carries the same title. Typing mirrors renameTask() in
 * supersync-helpers, including its explicit focus event.
 */
const renameCurrentInstance = async (
  client: SimulatedE2EClient,
  name: string,
  newName: string,
): Promise<void> => {
  const instance = currentInstance(client.page, name);
  const textarea = instance.locator('task-title textarea');
  await expect(async () => {
    await instance.locator('task-title').first().dispatchEvent('click');
    await textarea.waitFor({ state: 'visible', timeout: 2000 });
  }).toPass({ timeout: 10000 });
  await textarea.evaluate((el: HTMLTextAreaElement, value: string) => {
    el.focus();
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, newName);
  await expect.poll(() => getTaskTitleFromState(client, newName)).toBe(newName);
};

/** The phone's changes on day 16's instance: a rename and tracked time. */
const editOnPhone = async (
  phone: SimulatedE2EClient,
  name: string,
  editedName: string,
): Promise<void> => {
  await renameCurrentInstance(phone, name, editedName);
  await recordTaskTimeDelta(phone, editedName, DAY_16, TRACKED_MS);
  await expectExactTaskTime(phone, editedName, TRACKED_MS);
};

const expectPhoneEditsKept = async (
  client: SimulatedE2EClient,
  label: string,
  name: string,
  editedName: string,
): Promise<void> => {
  await expect
    .poll(() => getTaskTitleFromState(client, editedName), {
      timeout: 15000,
      message: `${label}: the phone's rename should survive`,
    })
    .toBe(editedName);
  await expectExactTaskTime(client, editedName, TRACKED_MS);
  const undone = (await getStoreSummary(client.page)).tasks.filter(
    (task) =>
      (task.title.includes(name) || task.title === editedName) &&
      !task.isDone &&
      !task.parentId,
  );
  expect(undone, `${label}: one instance for day 16`).toHaveLength(1);
};

test.describe('@supersync Recurring instance created on two devices (#11645)', () => {
  for (const order of ['phone uploads first', 'desktop uploads first'] as const) {
    test(`keeps the phone's edits on the twin instance: ${order}`, async ({
      browser,
      baseURL,
      testRunId,
    }) => {
      let phone: SimulatedE2EClient | null = null;
      let desktop: SimulatedE2EClient | null = null;

      try {
        const user = await createTestUser(testRunId);
        const syncConfig = getSuperSyncConfig(user);
        const name = `Daily-${testRunId}`;
        const editedName = `Edited-${testRunId}`;

        phone = await createSimulatedClient(browser, baseURL!, 'Phone', testRunId);
        desktop = await createSimulatedClient(browser, baseURL!, 'Desktop', testRunId);
        // Mid-afternoon, so setup cannot cross midnight on its own (#9728 spec).
        for (const client of [phone, desktop]) {
          await client.page.clock.setSystemTime(new Date('2026-06-15T15:00:00'));
          await client.page.reload();
          await client.workView.waitForTaskList();
        }
        await phone.sync.setupSuperSync(syncConfig);
        await desktop.sync.setupSuperSync(syncConfig);

        await phone.workView.addTask(name);
        await waitForTask(phone.page, name);
        await openTaskDetail(phone.page, name);
        await openRecurDialog(phone.page);
        await saveRecurDialog(phone.page);
        await phone.page.keyboard.press('Escape');
        await phone.sync.syncAndWait();
        await desktop.sync.syncAndWait();
        await waitForTask(desktop.page, name);

        if (order === 'phone uploads first') {
          // The desktop is asleep while the phone works and syncs.
          await desktop.context.setOffline(true);
          await advanceToDay16(phone, name, PHONE_TIME);
          await editOnPhone(phone, name, editedName);
          await phone.sync.syncAndWait();
          // It wakes up, creates its own instance (newer), then syncs.
          await advanceToDay16(desktop, name, DESKTOP_TIME);
          await desktop.context.setOffline(false);
          await desktop.sync.syncAndWait();
        } else {
          // The phone works offline; the desktop creates later but uploads first.
          await phone.context.setOffline(true);
          await advanceToDay16(phone, name, PHONE_TIME);
          await editOnPhone(phone, name, editedName);
          await advanceToDay16(desktop, name, DESKTOP_TIME);
          await desktop.sync.syncAndWait();
          await phone.context.setOffline(false);
          await phone.sync.syncAndWait();
        }

        await phone.sync.syncAndWait();
        await desktop.sync.syncAndWait();
        await phone.sync.syncAndWait();

        await expectPhoneEditsKept(phone, 'phone', name, editedName);
        await expectPhoneEditsKept(desktop, 'desktop', name, editedName);
      } finally {
        if (phone) await closeClient(phone);
        if (desktop) await closeClient(desktop);
      }
    });
  }
});
