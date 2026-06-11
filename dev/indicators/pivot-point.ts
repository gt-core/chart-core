import { registerIndicator } from '../../src/extension/indicator'

/**
 * Pivot Points Standard Indicator (TradingView Traditional style)
 * 
 * Traditional Formulas (using previous period's HLC):
 * P  = (prevHigh + prevLow + prevClose) / 3
 * R1 = P * 2 - prevLow
 * S1 = P * 2 - prevHigh
 * R2 = P + (prevHigh - prevLow)
 * S2 = P - (prevHigh - prevLow)
 * R3 = P * 2 + (prevHigh - 2 * prevLow)
 * S3 = P * 2 - (2 * prevHigh - prevLow)
 * R4 = P * 3 + (prevHigh - 3 * prevLow)
 * S4 = P * 3 - (3 * prevHigh - prevLow)
 * R5 = P * 4 + (prevHigh - 4 * prevLow)
 * S5 = P * 4 - (4 * prevHigh - prevLow)
 */

interface PivotResult {
  p: number | null
  r1: number | null
  r2: number | null
  r3: number | null
  r4: number | null
  r5: number | null
  s1: number | null
  s2: number | null
  s3: number | null
  s4: number | null
  s5: number | null
}

const COLORS = {
  pivot: '#FF9800',
  r1: '#4CAF50',
  r2: '#388E3C',
  r3: '#1B5E20',
  r4: '#1B5E20',
  r5: '#1B5E20',
  s1: '#F44336',
  s2: '#D32F2F',
  s3: '#B71C1C',
  s4: '#B71C1C',
  s5: '#B71C1C',
}

function calcPivotLevels(prevHigh: number, prevLow: number, prevClose: number) {
  const p = (prevHigh + prevLow + prevClose) / 3
  return {
    p,
    r1: 2 * p - prevLow,
    s1: 2 * p - prevHigh,
    r2: p + (prevHigh - prevLow),
    s2: p - (prevHigh - prevLow),
    r3: 2 * p + (prevHigh - 2 * prevLow),
    s3: 2 * p - (2 * prevHigh - prevLow),
    r4: 3 * p + (prevHigh - 3 * prevLow),
    s4: 3 * p - (3 * prevHigh - prevLow),
    r5: 4 * p + (prevHigh - 4 * prevLow),
    s5: 4 * p - (4 * prevHigh - prevLow),
  }
}

registerIndicator<PivotResult, number>({
  name: 'PIVOT_POINT',
  shortName: 'Pivot',
  series: 'price',
  calcParams: [5], // pivotsBack
  figures: [
    { key: 'p', title: 'P: ', type: 'line' },
    { key: 'r1', title: 'R1: ', type: 'line' },
    { key: 'r2', title: 'R2: ', type: 'line' },
    { key: 'r3', title: 'R3: ', type: 'line' },
    { key: 'r4', title: 'R4: ', type: 'line' },
    { key: 'r5', title: 'R5: ', type: 'line' },
    { key: 's1', title: 'S1: ', type: 'line' },
    { key: 's2', title: 'S2: ', type: 'line' },
    { key: 's3', title: 'S3: ', type: 'line' },
    { key: 's4', title: 'S4: ', type: 'line' },
    { key: 's5', title: 'S5: ', type: 'line' }
  ],

  calc: (dataList, indicator) => {
    const [pivotsBack] = indicator.calcParams
    const len = dataList.length
    const NULL: PivotResult = { p: null, r1: null, r2: null, r3: null, r4: null, r5: null, s1: null, s2: null, s3: null, s4: null, s5: null }
    const result: PivotResult[] = []

    if (len === 0) return []

    // Detect daily sessions from timestamps
    // A new session starts when the date (UTC) changes
    const sessionBounds: number[] = [0] // indices where new sessions start

    for (let i = 1; i < len; i++) {
      const prevTs = dataList[i - 1].timestamp
      const currTs = dataList[i].timestamp

      if (prevTs == null || currTs == null) continue

      // Normalize timestamps (handle seconds vs ms)
      const prev = prevTs < 1e12 ? prevTs * 1000 : prevTs
      const curr = currTs < 1e12 ? currTs * 1000 : currTs

      const prevDay = Math.floor(prev / 86400000)
      const currDay = Math.floor(curr / 86400000)

      if (currDay !== prevDay) {
        sessionBounds.push(i)
      }
    }

    // If no day boundaries detected, try gap-based detection (>4h gap = new session)
    if (sessionBounds.length <= 1 && len > 10) {
      sessionBounds.length = 0
      sessionBounds.push(0)

      for (let i = 1; i < len; i++) {
        const prevTs = dataList[i - 1].timestamp
        const currTs = dataList[i].timestamp
        if (prevTs == null || currTs == null) continue

        const gap = Math.abs(currTs - prevTs)
        // If gap > 4 hours (either in seconds or ms)
        const gapMs = gap < 1e10 ? gap * 1000 : gap
        if (gapMs > 4 * 3600 * 1000) {
          sessionBounds.push(i)
        }
      }
    }

    // Last resort: if still only 1 session, split into equal chunks
    if (sessionBounds.length <= 1) {
      const chunkSize = Math.max(20, Math.floor(len / (pivotsBack + 1)))
      sessionBounds.length = 0
      for (let i = 0; i < len; i += chunkSize) {
        sessionBounds.push(i)
      }
    }

    // Build sessions: each session is [startIdx, endIdx]
    interface Session { start: number; end: number; high: number; low: number; close: number }
    const sessions: Session[] = []

    for (let s = 0; s < sessionBounds.length; s++) {
      const start = sessionBounds[s]
      const end = (s < sessionBounds.length - 1) ? sessionBounds[s + 1] - 1 : len - 1

      let high = -Infinity
      let low = Infinity
      for (let i = start; i <= end; i++) {
        if (dataList[i].high > high) high = dataList[i].high
        if (dataList[i].low < low) low = dataList[i].low
      }
      const close = dataList[end].close
      sessions.push({ start, end, high, low, close })
    }

    // Calculate pivots: each session (except first) gets pivot from previous session
    interface PivotZone { start: number; end: number; levels: ReturnType<typeof calcPivotLevels> }
    const zones: PivotZone[] = []

    for (let s = 1; s < sessions.length; s++) {
      const prev = sessions[s - 1]
      const curr = sessions[s]
      zones.push({
        start: curr.start,
        end: curr.end,
        levels: calcPivotLevels(prev.high, prev.low, prev.close)
      })
    }

    // Limit to pivotsBack
    const displayZones = zones.slice(-pivotsBack)

    // Build result
    // Create a map of index -> zone for quick lookup
    const zoneMap = new Map<number, PivotZone>()
    for (const zone of displayZones) {
      for (let i = zone.start; i <= zone.end; i++) {
        zoneMap.set(i, zone)
      }
    }

    for (let i = 0; i < len; i++) {
      const zone = zoneMap.get(i)
      if (zone) {
        result.push({ ...zone.levels })
      } else {
        result.push({ ...NULL })
      }
    }

    return result
  },

  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const visibleRange = chart.getVisibleRange()
    const resultData = indicator.result

    if (!resultData || resultData.length === 0) return false

    const from = Math.max(0, visibleRange.from)
    const to = Math.min(visibleRange.to, resultData.length)

    // Quick check: any data to draw?
    let hasAny = false
    for (let i = from; i < to; i++) {
      if (resultData[i] && resultData[i].p !== null) { hasAny = true; break }
    }
    if (!hasAny) return false

    ctx.save()
    ctx.lineWidth = 1.5

    const rightmostIdx = to - 1
    const priceLabels: { y: number; value: number; color: string; label: string }[] = []

    // Draw pivot regions
    let i = from
    while (i < to) {
      const d = resultData[i]
      if (!d || d.p === null) { i++; continue }

      // Find region end (contiguous bars with same P value)
      const pVal = d.p
      let end = i
      while (end + 1 < to && resultData[end + 1] && resultData[end + 1].p === pVal) {
        end++
      }

      const x1 = xAxis.convertToPixel(i)
      const x2 = xAxis.convertToPixel(end)
      const touchesRight = end >= rightmostIdx

      const lines: [string, number | null, string][] = [
        ['r5', d.r5, 'R5'],
        ['r4', d.r4, 'R4'],
        ['r3', d.r3, 'R3'],
        ['r2', d.r2, 'R2'],
        ['r1', d.r1, 'R1'],
        ['pivot', d.p, 'P'],
        ['s1', d.s1, 'S1'],
        ['s2', d.s2, 'S2'],
        ['s3', d.s3, 'S3'],
        ['s4', d.s4, 'S4'],
        ['s5', d.s5, 'S5'],
      ]

      for (const [colorKey, value, label] of lines) {
        if (value === null) continue
        const color = COLORS[colorKey as keyof typeof COLORS]
        const y = yAxis.convertToPixel(value)

        ctx.beginPath()
        ctx.strokeStyle = color
        ctx.moveTo(x1, y)
        ctx.lineTo(x2, y)
        ctx.stroke()

        // Left-side label
        ctx.fillStyle = color
        ctx.font = 'bold 10px sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'bottom'
        ctx.fillText(label, x1 + 3, y - 2)

        if (touchesRight) {
          priceLabels.push({ y, value, color, label })
        }
      }

      i = end + 1
    }

    // Right-side price labels
    if (priceLabels.length > 0) {
      const rEdge = bounding.width
      ctx.font = 'bold 10px sans-serif'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'

      for (const { y, value, color, label } of priceLabels) {
        const w = 62
        const h = 16
        const x = rEdge - w - 3

        ctx.fillStyle = color
        ctx.beginPath()
        ctx.roundRect(x, y - h / 2, w, h, 3)
        ctx.fill()

        ctx.fillStyle = '#fff'
        ctx.fillText(`${label} ${value.toFixed(2)}`, rEdge - 6, y)
      }
    }

    ctx.restore()
    return true
  }
})
