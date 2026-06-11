import { registerIndicator } from '../../src/extension/indicator'

/**
 * Spread Highlight Indicator
 * 
 * Highlights bars with a spread (high - low) greater than a configurable threshold
 * by drawing a semi-transparent background.
 */

interface SpreadData {
  rawSpread: number | null
}

registerIndicator<SpreadData, number>({
  name: 'SPREAD_HIGHLIGHT',
  shortName: 'Spread',
  series: 'price',
  calcParams: [10], // threshold for spread
  figures: [],

  calc: (dataList, indicator) => {
    return dataList.map(kline => ({
      rawSpread: kline.high - kline.low
    }))
  },

  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const visibleRange = chart.getVisibleRange()
    const resultData = indicator.result
    const chartStore = chart.getChartStore()
    const barSpace = chartStore.getBarSpace()
    const [threshold] = indicator.calcParams

    ctx.save()
    ctx.fillStyle = 'rgba(255, 0, 0, 0.15)'

    for (let i = visibleRange.from; i < visibleRange.to; i++) {
      const dataPoint = resultData[i]

      if (dataPoint && dataPoint.rawSpread !== null && dataPoint.rawSpread > threshold) {
        const xPixel = xAxis.convertToPixel(i)
        const barWidth = barSpace.bar

        ctx.fillRect(
          xPixel - barSpace.halfBar,
          0,
          barWidth,
          bounding.height
        )
      }
    }

    ctx.restore()

    return false
  }
})
