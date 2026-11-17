import { TaskSharedActions } from '../../../../root-store/meta/task-shared.actions';
import { Task } from '../../../../features/tasks/task.model';
import { executeIntent, Intent, SETUP_INTENTS, viewOf } from './sync-fuzz-actions';
import { FuzzDevice, SyncFuzzHarness } from './sync-fuzz-harness';

/**
 * #11645: a recurring task's instance for a day has a deterministic id
 * (`rpt_<cfgId>_<day>`), so two devices that each create today's instance
 * before syncing create the SAME entity twice. The phone (E) then tracks time
 * and edits notes; the desktop (B) only creates. Whole-entity LWW used to let
 * the desktop's bare Create win whenever it was the later op, and its
 * snapshot erased the phone's time and notes on every device.
 *
 * Each case varies which device uploads first and whether the bare Create is
 * older or newer than the phone's edits. All must keep the phone's edits.
 */
describe('repeat instance created on two devices (#11645)', () => {
  afterEach(() => SyncFuzzHarness.dispose());

  const ID = 'rpt_cfg1_2026-01-01';
  const run = (h: SyncFuzzHarness, d: FuzzDevice, intent: Intent): Promise<unknown> =>
    h.as(d, () => executeIntent(h, intent));
  // A repeat with a start time and reminder also schedules each new instance
  // (TaskRepeatCfgService._getScheduleActions). The task snapshot in that
  // payload differs per device (`created`), the schedule itself does not.
  const DUE = Date.UTC(2026, 0, 1, 9);
  const schedule = (h: SyncFuzzHarness, d: FuzzDevice): Promise<unknown> =>
    h.as(d, async () => {
      const state = (await h.state()) as { tasks: { entities: Record<string, Task> } };
      const task = state.tasks.entities[ID];
      await h.dispatch(
        TaskSharedActions.scheduleTaskWithTime({
          task,
          dueWithTime: DUE,
          remindAt: DUE,
          isMoveToBacklog: false,
          isSkipAutoRemoveFromToday: true,
        }),
      );
    });
  let withSchedule = false;
  const createAndEdit = async (h: SyncFuzzHarness, editor: FuzzDevice): Promise<void> => {
    await run(h, editor, ['addTask', ID, 'T']);
    if (withSchedule) await schedule(h, editor);
    await run(h, editor, ['track', ID, 3000]);
    await run(h, editor, ['editTaskNotes', ID, 'phone notes']);
  };
  const bareCreate = async (h: SyncFuzzHarness, bare: FuzzDevice): Promise<void> => {
    await run(h, bare, ['addTask', ID, 'T']);
    if (withSchedule) await schedule(h, bare);
  };

  const expectEditsKept = async (
    h: SyncFuzzHarness,
    devices: FuzzDevice[],
  ): Promise<void> => {
    for (const d of devices) {
      const t = viewOf(await h.as(d, () => h.state())).tasks.find((x) => x.id === ID);
      expect(t?.timeSpent).withContext(`${d.name} timeSpent`).toBe(3000);
      expect(t?.notes).withContext(`${d.name} notes`).toBe('phone notes');
    }
  };

  const cases: {
    name: string;
    steps: (h: SyncFuzzHarness, editor: FuzzDevice, bare: FuzzDevice) => Promise<void>;
  }[] = [
    {
      name: 'editor uploads first, bare Create is newer (the report)',
      steps: async (h, editor, bare) => {
        await createAndEdit(h, editor);
        await h.sync(editor);
        await bareCreate(h, bare);
        await h.sync(bare);
      },
    },
    {
      name: 'editor uploads first, bare Create is older',
      steps: async (h, editor, bare) => {
        await bareCreate(h, bare);
        await createAndEdit(h, editor);
        await h.sync(editor);
        await h.sync(bare);
      },
    },
    {
      name: 'bare Create uploads first and is newer',
      steps: async (h, editor, bare) => {
        await createAndEdit(h, editor);
        await bareCreate(h, bare);
        await h.sync(bare);
        await h.sync(editor);
      },
    },
    {
      name: 'bare Create uploads first and is older',
      steps: async (h, editor, bare) => {
        await bareCreate(h, bare);
        await h.sync(bare);
        await createAndEdit(h, editor);
        await h.sync(editor);
      },
    },
  ];

  // The report's main symptom: the phone only tracked time on the instance.
  it('keeps time tracked without any other edit (bare Create newer)', async () => {
    const h = await SyncFuzzHarness.create();
    const [editor, bare] = [await h.addDevice('E'), await h.addDevice('B')];
    for (const intent of SETUP_INTENTS) await run(h, editor, intent);
    for (const d of [editor, bare]) await h.sync(d);

    await run(h, editor, ['addTask', ID, 'T']);
    await run(h, editor, ['track', ID, 3000]);
    await h.sync(editor);
    await run(h, bare, ['addTask', ID, 'T']);
    for (let round = 0; round < 3; round++) {
      for (const d of [bare, editor]) await h.sync(d);
    }

    expect(h.events).toEqual([]);
    for (const d of [editor, bare]) {
      const t = viewOf(await h.as(d, () => h.state())).tasks.find((x) => x.id === ID);
      expect(t?.timeSpent).withContext(`${d.name} timeSpent`).toBe(3000);
    }
  });

  for (const c of cases.flatMap((x) => [
    { ...x, scheduled: false },
    { ...x, scheduled: true },
  ])) {
    const label = c.scheduled ? ' (scheduled repeat)' : '';
    it(`keeps the editing device's time and notes: ${c.name}${label}`, async () => {
      withSchedule = c.scheduled;
      const h = await SyncFuzzHarness.create();
      const [editor, bare] = [await h.addDevice('E'), await h.addDevice('B')];
      for (const intent of SETUP_INTENTS) await run(h, editor, intent);
      for (const d of [editor, bare]) await h.sync(d);

      await c.steps(h, editor, bare);
      for (let round = 0; round < 3; round++) {
        for (const d of [bare, editor]) await h.sync(d);
      }

      expect(h.events).toEqual([]);
      await expectEditsKept(h, [editor, bare]);
      // Replaying each op log must give the same result.
      for (const d of [editor, bare]) await h.restart(d);
      await expectEditsKept(h, [editor, bare]);
    });
  }
});
