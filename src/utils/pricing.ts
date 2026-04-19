/**
 * Pure pricing math shared by capabilities, memory, and tests.
 * Lives in utils/ (leaf module) so memory/learning-loop.ts can use it
 * without creating a memory → capabilities import (architecture direction
 * violation — memory is a leaf, see scripts/check-agent-layer-isolation.ts).
 */

/**
 * Fractional delta between the median of an estimate range and the actual
 * realized price. Positive = actual is above median. Returns 0 when median
 * is 0 to avoid divide-by-zero.
 */
export function calcEstimateDelta(
  estimateRange: { low: number; high: number },
  actualPrice: number,
): number {
  const median = (estimateRange.low + estimateRange.high) / 2;
  if (median === 0) return 0;
  return (actualPrice - median) / median;
}
