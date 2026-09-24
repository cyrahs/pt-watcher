import { logEvent } from "../services/events";

export interface JobStatus {
  name: string;
  lastRunAt: Date | null;
  lastFinishedAt: Date | null;
  lastError: string | null;
  running: boolean;
}

interface Job {
  name: string;
  run: () => Promise<void>;
  intervalSec: () => number;
  status: JobStatus;
  timer: ReturnType<typeof setTimeout> | null;
}

const jobs = new Map<string, Job>();

export function registerJob(name: string, run: () => Promise<void>, intervalSec: () => number) {
  jobs.set(name, {
    name,
    run,
    intervalSec,
    timer: null,
    status: { name, lastRunAt: null, lastFinishedAt: null, lastError: null, running: false },
  });
}

/** 单 job 互斥；手动触发与定时触发共用 */
export async function runJob(name: string): Promise<void> {
  const job = jobs.get(name);
  if (!job) throw new Error(`unknown job: ${name}`);
  if (job.status.running) return;
  job.status.running = true;
  job.status.lastRunAt = new Date();
  try {
    await job.run();
    if (job.status.lastError !== null) {
      await logEvent("job_recovered", `任务 ${name} 恢复正常`, {
        payload: { job: name, previousError: job.status.lastError },
      });
    }
    job.status.lastError = null;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[job:${name}] failed:`, e);
    // 只在状态变化（首次失败或错误变了）时记事件：高频任务持续失败不刷屏
    if (error !== job.status.lastError) {
      await logEvent("job_failed", `任务 ${name} 失败: ${error}`, { payload: { job: name, error } });
    }
    job.status.lastError = error;
  } finally {
    job.status.running = false;
    job.status.lastFinishedAt = new Date();
  }
}

function schedule(job: Job) {
  const base = job.intervalSec() * 1000;
  const jitter = base * 0.1 * Math.random();
  job.timer = setTimeout(async () => {
    await runJob(job.name);
    schedule(job);
  }, base + jitter);
}

export function startScheduler() {
  for (const job of jobs.values()) {
    // 启动后先错峰跑一轮
    setTimeout(() => {
      void runJob(job.name).then(() => schedule(job));
    }, 3000 + Math.random() * 5000);
  }
}

export function jobStatuses(): JobStatus[] {
  return [...jobs.values()].map((j) => ({ ...j.status }));
}

export function hasJob(name: string): boolean {
  return jobs.has(name);
}
