/**
 * Custom Indicators Registry
 * 
 * Add your custom indicators here by importing them.
 * Each indicator file should call registerIndicator() to self-register.
 * 
 * Usage:
 *   1. Create a new file in this folder (e.g., my-indicator.ts)
 *   2. Use registerIndicator() from '../../src/extension/indicator'
 *   3. Import the file below
 * 
 * Example indicator file:
 * 
 *   import { registerIndicator } from '../../src/extension/indicator'
 *   
 *   registerIndicator({
 *     name: 'MY_INDICATOR',
 *     shortName: 'MI',
 *     series: 'normal',  // 'normal' | 'price' | 'volume'
 *     calcParams: [14],
 *     figures: [{ key: 'value', title: 'Value: ', type: 'line' }],
 *     calc: (dataList, indicator) => {
 *       return dataList.map(k => ({ value: k.close }))
 *     },
 *     // Optional: custom draw function for advanced rendering
 *     draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
 *       // Custom drawing logic
 *       return false // return true to skip default figure drawing
 *     }
 *   })
 */

// Built-in custom indicators
import './mid'
import './spread-highlight'
import './bollinger-band'
import './pivot-point'

// Add your custom indicators below:
// import './my-custom-indicator'
