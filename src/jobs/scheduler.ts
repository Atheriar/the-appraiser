/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { errMsg, type Logger } from '../server/log.js';

export interface JobDef {
  name: string;
  /** Interval in ms; read every cycle so settings changes apply without restart. 0/negative = disabled. */
  interval: () => number;
  run: () => Promise<void>;
  /** Delay before the first run (default 0). */
  initialDelayMs?: number;
}

export interface JobStatus { name: string; lastRunAt: number | null; lastOkAt: number | null; lastError: string | null; nextRunAt: number | null; running: boolean }

/** Single-flight interval scheduler (setTimeout chain, no overlap, errors captured). */
export class Scheduler {
  private jobs = new Map<string, { def: JobDef; status: JobStatus; timer: NodeJS.Timeout | null }>();
  private stopped = false;

  constructor(private readonly log: Logger) {}

  add(def: JobDef): void {
    this.jobs.set(def.name, { def, status: { name: def.name, lastRunAt: null, lastOkAt: null, lastError: null, nextRunAt: null, running: false }, timer: null });
  }

  start(): void {
    this.stopped = false;
    for (const j of this.jobs.values()) this.schedule(j.def.name, j.def.initialDelayMs ?? 0);
  }

  stop(): void {
    this.stopped = true;
    for (const j of this.jobs.values()) { if (j.timer) clearTimeout(j.timer); j.timer = null; j.status.nextRunAt = null; }
  }

  private schedule(name: string, delay: number): void {
    const j = this.jobs.get(name);
    if (!j || this.stopped) return;
    if (j.timer) clearTimeout(j.timer);
    if (delay < 0) { j.status.nextRunAt = null; return; }
    j.status.nextRunAt = Date.now() + delay;
    j.timer = setTimeout(() => { void this.runNow(name); }, delay);
    j.timer.unref?.();
  }

  /** Run a job now (if not already running) and reschedule. */
  async runNow(name: string): Promise<void> {
    const j = this.jobs.get(name);
    if (!j) return;
    if (j.status.running) return;
    j.status.running = true;
    j.status.lastRunAt = Date.now();
    try {
      await j.def.run();
      j.status.lastOkAt = Date.now();
      j.status.lastError = null;
    } catch (e) {
      j.status.lastError = errMsg(e);
      this.log.warn(`job ${name} failed`, e);
    } finally {
      j.status.running = false;
      const iv = j.def.interval();
      this.schedule(name, iv > 0 ? iv : -1);
    }
  }

  statuses(): JobStatus[] { return [...this.jobs.values()].map((j) => ({ ...j.status })); }
}
