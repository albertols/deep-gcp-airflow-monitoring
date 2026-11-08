/**
 * How the NFR-PERF tests measure an analysis: the CPU time of the thread that runs it, and its wall time.
 *
 * Not wall time: test files run in parallel and other work shares the machine, which stretches wall time
 * without the analysis costing more. Not the process's CPU time either: V8 also collects garbage on helper
 * threads, in parallel with the analysis, and how much CPU those take depends on the machine's core count
 * and load (CI measured 2.2 s of process CPU where the analysis thread used 1.3 s). On an idle machine the
 * analysis thread's CPU time, its own garbage collection pauses included, is the response time.
 *
 * `process.threadCpuUsage` exists from Node.js 22.19; on an older 22.x the process's CPU time stands in.
 */
export interface Measured<T> {
  readonly result: T;
  readonly cpuMs: number;
  readonly wallMs: number;
}

const usage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage =
  typeof process.threadCpuUsage === 'function'
    ? (previous) => process.threadCpuUsage(previous)
    : (previous) => process.cpuUsage(previous);

export async function measureCpu<T>(work: () => Promise<T>): Promise<Measured<T>> {
  const cpu = usage();
  const wall = performance.now();
  const result = await work();
  const used = usage(cpu);
  return {
    result,
    cpuMs: Math.round((used.user + used.system) / 1000),
    wallMs: Math.round(performance.now() - wall),
  };
}
