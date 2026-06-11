import { registerIndicator } from '../../src/extension/indicator'

/**
 * Custom MID Indicator
 * 
 * Simple moving average of close prices over a configurable period.
 */

interface MidData {
  mid: number | null
}

registerIndicator<MidData, number>({
  name: 'CUSTOM_MID',
  shortName: 'MID',
  series: 'price',
  calcParams: [14],
  figures: [
    { key: 'mid', title: 'MID: ', type: 'line' }
  ],
  calc: (dataList, indicator) => {
    const [period] = indicator.calcParams
    return dataList.map((k, i) => {
      if (i < period - 1) {
        return { mid: null }
      }
      const start = i - period + 1
      const slice = dataList.slice(start, i + 1)
      const sum = slice.reduce((acc, item) => acc + item.close, 0)
      return { mid: sum / period }
    })
  }
})