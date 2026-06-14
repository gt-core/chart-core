/**
 * TradingView-Compact Features
 * 
 * This module provides TradingView-like behavior enhancements:
 * - Dynamic zoom anchor switching (cursor vs last bar)
 * - MinTick-aligned Y-axis rendering for proper price precision
 */

import { registerYAxis, registerXAxis } from '../src/index'
import {
  generateTickAlignedValues,
  getPrecisionFromValue
} from './tick-utils'

// ============================================================================
// Types
// ============================================================================

export interface ChartInstance {
  setZoomAnchor: (anchor: 'cursor' | 'last_bar') => void
  overrideYAxis: (options: { name: string }) => void
  overrideXAxis: (options: { name: string }) => void
  resize: () => void
}

export interface SymbolMetadata {
  minTick: number
  pricePrecision: number
}

export interface TVCompactConfig {
  connectionUserId: string
  connectionGroupId: string
  currencyCode: string
  baseUrl: string
  getAccessToken: () => string | null
}

// ============================================================================
// State
// ============================================================================

let currentSymbolMetadata: SymbolMetadata | null = null

export function setSymbolMetadata (metadata: SymbolMetadata | null): void {
  currentSymbolMetadata = metadata
}

export function getSymbolMetadata (): SymbolMetadata | null {
  return currentSymbolMetadata
}

// ============================================================================
// Utilities
// ============================================================================

function formatWithThousandsSeparator (value: number, precision: number): string {
  const fixed = value.toFixed(precision)
  const parts = fixed.split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

// ============================================================================
// Y-Axis Registration
// ============================================================================

registerYAxis({
  name: 'mintick',
  
  createTicks: ({ range, bounding, defaultTicks }) => {
    if (!currentSymbolMetadata || currentSymbolMetadata.minTick <= 0) {
      return defaultTicks
    }

    const { displayFrom, displayTo } = range
    const { height } = bounding
    const { minTick, pricePrecision } = currentSymbolMetadata

    const result = generateTickAlignedValues({
      minPrice: displayFrom,
      maxPrice: displayTo,
      minTick,
      chartHeightInPixels: height,
      minPixelSpacing: 35
    })

    if (result.ticks.length === 0) {
      return defaultTicks
    }

    const priceRange = displayTo - displayFrom
    const effectivePrecision = Math.max(result.precision, pricePrecision)

    return result.ticks
      .map(tickValue => {
        const normalizedPosition = (tickValue - displayFrom) / priceRange
        const coord = Math.round((1 - normalizedPosition) * height)
        
        return {
          coord,
          value: tickValue,
          text: formatWithThousandsSeparator(tickValue, effectivePrecision)
        }
      })
      .filter(tick => tick.coord > 0 && tick.coord < height)
  },

  displayValueToText: (value: number, precision: number) => {
    if (currentSymbolMetadata && currentSymbolMetadata.minTick > 0) {
      const minTickPrecision = getPrecisionFromValue(currentSymbolMetadata.minTick)
      const effectivePrecision = Math.max(minTickPrecision, precision)
      return formatWithThousandsSeparator(value, effectivePrecision)
    }
    return formatWithThousandsSeparator(value, precision)
  }
})

// ============================================================================
// X-Axis Registration (Default behavior - aligned with candles)
// ============================================================================

registerXAxis({
  name: 'tvcompact',
  createTicks: ({ defaultTicks }) => defaultTicks
})

// ============================================================================
// Symbol Metadata API
// ============================================================================

export async function fetchSymbolMetadata (
  symbol: string,
  config: TVCompactConfig
): Promise<SymbolMetadata | null> {
  const { connectionUserId, connectionGroupId, currencyCode, baseUrl, getAccessToken } = config
  
  try {
    const accessToken = getAccessToken()
    if (!accessToken) {
      console.warn('[TVCompact] No access token available for symbol metadata fetch')
      return null
    }

    const params = new URLSearchParams({
      'connection-user-id': connectionUserId,
      'connection-group-id': connectionGroupId,
      'symbol': symbol,
      'currencyCode': currencyCode
    })
    
    const response = await fetch(`${baseUrl}/symbols?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    })
    
    if (!response.ok) {
      console.warn(`[TVCompact] Symbol metadata fetch failed: ${response.status}`)
      return null
    }

    const data = await response.json()
    const minTick = data?.minTick ?? data?.data?.minTick ?? null
    const pricePrecision = data?.pricePrecision ?? data?.data?.pricePrecision ?? 2

    if (minTick === null || typeof minTick !== 'number' || minTick <= 0) {
      return null
    }

    return { minTick, pricePrecision }
  } catch (error) {
    console.error('[TVCompact] Error fetching symbol metadata:', error)
    return null
  }
}

// ============================================================================
// Zoom Anchor Key Bindings
// ============================================================================

export function setupZoomAnchorKeyBindings (chart: ChartInstance | null): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey && chart) {
      chart.setZoomAnchor('cursor')
    }
  }

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Meta' && chart) {
      chart.setZoomAnchor('last_bar')
    }
  }

  const onBlur = (): void => {
    if (chart) {
      chart.setZoomAnchor('last_bar')
    }
  }

  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  return () => {
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
  }
}

// ============================================================================
// Symbol Change Handler Factory
// ============================================================================

export function createSymbolChangeHandler (
  config: TVCompactConfig,
  getChart: () => ChartInstance | null
) {
  return async function onSymbolChange (symbol: string): Promise<void> {
    const metadata = await fetchSymbolMetadata(symbol, config)
    setSymbolMetadata(metadata)
    
    const chart = getChart()
    if (chart) {
      chart.resize()
    }
  }
}

// ============================================================================
// Main Setup
// ============================================================================

export interface TVCompactSetupOptions {
  chart: ChartInstance
  config: TVCompactConfig
}

export interface TVCompactInstance {
  onSymbolChange: (symbol: string) => Promise<void>
  cleanup: () => void
}

export function setupTVCompact (options: TVCompactSetupOptions): TVCompactInstance {
  const { chart, config } = options
  
  chart.overrideYAxis({ name: 'mintick' })
  chart.overrideXAxis({ name: 'tvcompact' })
  
  const cleanupZoomAnchor = setupZoomAnchorKeyBindings(chart)
  const onSymbolChange = createSymbolChangeHandler(config, () => chart)
  
  return {
    onSymbolChange,
    cleanup: () => {
      cleanupZoomAnchor()
      setSymbolMetadata(null)
    }
  }
}
