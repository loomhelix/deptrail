export const TIMING_RUNS = 3

export function fastestRun<T>(work: () => T, runs = TIMING_RUNS): { result: T; elapsed: number } {
  let fastest = Number.POSITIVE_INFINITY
  let result = work()
  for (let run = 0; run < runs; run++) {
    const started = performance.now()
    result = work()
    fastest = Math.min(fastest, performance.now() - started)
  }
  return { result, elapsed: fastest }
}
