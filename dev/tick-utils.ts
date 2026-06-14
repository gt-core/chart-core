/**
 * Tick-Aligned Y-Axis Utilities
 * 
 * Provides mathematical utilities for generating Y-axis tick values
 * that align to an asset's minimum tick size (minTick).
 * 
 * This ensures Y-axis values display clean numbers like 7,407.25
 * instead of floating-point artifacts like 7,407.08.
 */

// ============================================================================
// Types
// ============================================================================

export interface TickAlignedParams {
  minPrice: number
  maxPrice: number
  minTick: number
  chartHeightInPixels: number
  minPixelSpacing?: number
}

export interface TickAlignedResult {
  step: number
  precision: number
  ticks: number[]
  maxTicks: number
}

// ============================================================================
// Precision Utilities
// ============================================================================

/**
 * Extracts decimal precision from a numeric value.
 * 
 * @example
 * getPrecisionFromValue(0.25)  // returns 2
 * getPrecisionFromValue(1)     // returns 0
 * getPrecisionFromValue(0.001) // returns 3
 */
export function getPrecisionFromValue (value: number | string): number {
  const str = String(value)
  const dotIndex = str.indexOf('.')
  return dotIndex < 0 ? 0 : str.length - dotIndex - 1
}

/**
 * Snaps a value to the nearest multiple of step.
 * Uses integer math internally to avoid floating-point errors.
 */
export function snapToMultiple (value: number, step: number, precision: number): number {
  const multiplier = Math.pow(10, precision)
  const scaledValue = Math.round(value * multiplier)
  const scaledStep = Math.round(step * multiplier)
  const snapped = Math.round(scaledValue / scaledStep) * scaledStep
  return snapped / multiplier
}

// ============================================================================
// Step Calculation
// ============================================================================

const NICE_MULTIPLIERS = [
  1, 2, 2.5, 4, 5, 10, 20, 25, 40, 50, 
  100, 200, 250, 400, 500, 1000
]

/**
 * Calculates a tick step size that is a clean multiple of minTick.
 * 
 * The algorithm finds the smallest multiplier that provides adequate
 * spacing given the price range and maximum allowed ticks.
 */
export function calculateTickAlignedStep (
  range: number, 
  maxTicks: number, 
  minTick: number
): number {
  if (range <= 0 || maxTicks <= 0 || minTick <= 0) {
    return minTick
  }

  const roughStep = range / maxTicks
  
  if (roughStep <= minTick) {
    return minTick
  }

  const multiplier = roughStep / minTick
  
  for (const nm of NICE_MULTIPLIERS) {
    if (nm >= multiplier) {
      return nm * minTick
    }
  }
  
  const magnitude = Math.pow(10, Math.floor(Math.log10(multiplier)))
  const normalized = multiplier / magnitude
  
  let niceNormalized: number
  if (normalized <= 1) {
    niceNormalized = 1
  } else if (normalized <= 2) {
    niceNormalized = 2
  } else if (normalized <= 2.5) {
    niceNormalized = 2.5
  } else if (normalized <= 5) {
    niceNormalized = 5
  } else {
    niceNormalized = 10
  }
  
  return Math.ceil(niceNormalized * magnitude) * minTick
}

// ============================================================================
// Tick Generation
// ============================================================================

/**
 * Generates Y-axis tick values aligned to the asset's minTick.
 * 
 * Ensures:
 * - All tick values are exact multiples of the step size
 * - Adequate spacing between labels (default 50px minimum)
 * - No floating-point precision artifacts
 * 
 * @example
 * generateTickAlignedValues({
 *   minPrice: 7400,
 *   maxPrice: 7500,
 *   minTick: 0.25,
 *   chartHeightInPixels: 400
 * })
 * // Returns ticks at 7400, 7412.50, 7425, 7437.50, ...
 */
export function generateTickAlignedValues (params: TickAlignedParams): TickAlignedResult {
  const {
    minPrice,
    maxPrice,
    minTick,
    chartHeightInPixels,
    minPixelSpacing = 35
  } = params

  const precision = getPrecisionFromValue(minTick)
  const range = maxPrice - minPrice

  if (range <= 0 || chartHeightInPixels <= 0) {
    return {
      step: minTick,
      precision,
      ticks: [],
      maxTicks: 0
    }
  }

  const maxTicks = Math.max(1, Math.floor(chartHeightInPixels / minPixelSpacing))
  const step = calculateTickAlignedStep(range, maxTicks, minTick)

  const firstTick = snapToMultiple(
    Math.ceil(minPrice / step) * step, 
    step, 
    precision
  )
  const lastTick = snapToMultiple(
    Math.floor(maxPrice / step) * step, 
    step, 
    precision
  )

  const ticks: number[] = []
  const stepPrecision = getPrecisionFromValue(step)
  const effectivePrecision = Math.max(precision, stepPrecision)
  
  let current = firstTick
  const maxIterations = maxTicks + 10
  let iterations = 0
  
  while (current <= lastTick + step * 0.0001 && iterations < maxIterations) {
    ticks.push(+current.toFixed(effectivePrecision))
    current = +(current + step).toFixed(effectivePrecision)
    iterations++
  }

  return {
    step,
    precision: effectivePrecision,
    ticks,
    maxTicks
  }
}
