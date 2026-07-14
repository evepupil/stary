export const PHYSICS_SCHEDULER_INTERVAL_MS = 16;
export const SIMULATION_SECONDS_PER_REAL_SECOND_AT_1X = 1;
export const MAX_SIMULATION_ADVANCE_PER_SLICE_SECONDS = 86_400;

export type ScheduledPhysicsTask = ReturnType<typeof setTimeout>;

export interface PhysicsScheduler {
  cancel(task: ScheduledPhysicsTask): void;
  nowMilliseconds(): number;
  schedule(task: () => void): ScheduledPhysicsTask;
}

export const browserPhysicsScheduler: PhysicsScheduler = {
  cancel: (task) => {
    clearTimeout(task);
  },
  nowMilliseconds: () => performance.now(),
  schedule: (task) => setTimeout(task, PHYSICS_SCHEDULER_INTERVAL_MS),
};
