import { registerIndicator } from '../../src/extension/indicator'

/**
 * Bollinger Bands Indicator
 * 
 * Shows upper, middle (SMA), and lower bands with configurable period and standard deviation multiplier.
 * The area between upper and lower bands is filled with a semi-transparent color.
 */

interface BollingerData {
  upper: number | null
  middle: number | null
  lower: number | null
}

registerIndicator<BollingerData, number>({
  name: 'BOLLINGER_BAND',
  shortName: 'BB',
  series: 'price',
  calcParams: [20, 2], // [period, stddev multiplier]
  figures: [
    { key: 'upper', title: 'Upper: ', type: 'line' },
    { key: 'middle', title: 'Middle: ', type: 'line' },
    { key: 'lower', title: 'Lower: ', type: 'line' }
  ],

  calc: (dataList, indicator) => {
    const [period, multiplier] = indicator.calcParams
    
    return dataList.map((_, i) => {
      if (i < period - 1) {
        return { upper: null, middle: null, lower: null }
      }

      const slice = dataList.slice(i - period + 1, i + 1)
      const closes = slice.map(k => k.close)
      
      // Calculate SMA (middle band)
      const sum = closes.reduce((acc, val) => acc + val, 0)
      const sma = sum / period
      
      // Calculate standard deviation
      const squaredDiffs = closes.map(val => Math.pow(val - sma, 2))
      const avgSquaredDiff = squaredDiffs.reduce((acc, val) => acc + val, 0) / period
      const stdDev = Math.sqrt(avgSquaredDiff)
      
      return {
        upper: sma + multiplier * stdDev,
        middle: sma,
        lower: sma - multiplier * stdDev
      }
    })
  },

  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const visibleRange = chart.getVisibleRange()
    const resultData = indicator.result

    // Collect points for the filled area
    const upperPoints: { x: number; y: number }[] = []
    const lowerPoints: { x: number; y: number }[] = []

    for (let i = visibleRange.from; i < visibleRange.to; i++) {
      const data = resultData[i]
      if (!data || data.upper === null || data.lower === null) continue

      const x = xAxis.convertToPixel(i)
      const upperY = yAxis.convertToPixel(data.upper)
      const lowerY = yAxis.convertToPixel(data.lower)

      upperPoints.push({ x, y: upperY })
      lowerPoints.push({ x, y: lowerY })
    }

    if (upperPoints.length < 2) {
      return false
    }

    ctx.save()

    // Draw filled area between bands
    ctx.beginPath()
    ctx.moveTo(upperPoints[0].x, upperPoints[0].y)
    
    // Draw upper line forward
    for (let i = 1; i < upperPoints.length; i++) {
      ctx.lineTo(upperPoints[i].x, upperPoints[i].y)
    }
    
    // Draw lower line backward to close the shape
    for (let i = lowerPoints.length - 1; i >= 0; i--) {
      ctx.lineTo(lowerPoints[i].x, lowerPoints[i].y)
    }
    
    ctx.closePath()
    ctx.fillStyle = 'rgba(33, 150, 243, 0.15)'
    ctx.fill()

    // Draw upper band line
    ctx.beginPath()
    ctx.moveTo(upperPoints[0].x, upperPoints[0].y)
    for (let i = 1; i < upperPoints.length; i++) {
      ctx.lineTo(upperPoints[i].x, upperPoints[i].y)
    }
    ctx.strokeStyle = 'rgba(33, 150, 243, 0.8)'
    ctx.lineWidth = 1
    ctx.stroke()

    // Draw lower band line
    ctx.beginPath()
    ctx.moveTo(lowerPoints[0].x, lowerPoints[0].y)
    for (let i = 1; i < lowerPoints.length; i++) {
      ctx.lineTo(lowerPoints[i].x, lowerPoints[i].y)
    }
    ctx.strokeStyle = 'rgba(33, 150, 243, 0.8)'
    ctx.lineWidth = 1
    ctx.stroke()

    // Draw middle band line
    ctx.beginPath()
    let firstMiddle = true
    for (let i = visibleRange.from; i < visibleRange.to; i++) {
      const data = resultData[i]
      if (!data || data.middle === null) continue

      const x = xAxis.convertToPixel(i)
      const y = yAxis.convertToPixel(data.middle)

      if (firstMiddle) {
        ctx.moveTo(x, y)
        firstMiddle = false
      } else {
        ctx.lineTo(x, y)
      }
    }
    ctx.strokeStyle = 'rgba(255, 193, 7, 0.9)'
    ctx.lineWidth = 1.5
    ctx.stroke()

    ctx.restore()

    return true // Skip default figure drawing since we handled it
  }
})
