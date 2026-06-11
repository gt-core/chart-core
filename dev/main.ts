/**
 * Chart Development Application
 * 
 * Entry point for the chart-core development environment.
 */

import { init, dispose } from '../src/index'
import type { SymbolInfo } from '../src/common/SymbolInfo'
import type { Period } from '../src/common/Period'
import type { DataLoader, DataLoaderGetBarsParams, DataLoaderSubscribeBarParams, DataLoaderUnsubscribeBarParams } from '../src/common/DataLoader'
import type { KLineData } from '../src/common/Data'

import { styles } from './config'

// Register all custom indicators
import './indicators'
import { getAccessToken, getRefreshToken, storeTokens } from './auth-constants'
import { setupTVCompact, setSymbolMetadata, type TVCompactInstance } from './tv-compact'

// ============================================================================
// Environment Configuration
// ============================================================================

declare const TradiumDatafeed: any

const ENV = {
  MARKET_DATA_URL: import.meta.env.VITE_MARKET_DATA_BASE_URL || 'https://cug-market-data.tradesea.ai/v1',
  MARKET_DATA_WS: import.meta.env.VITE_MARKET_DATA_WS_URL || 'wss://cug-market-data.tradesea.ai/v1/wss',
  IDENTITY_URL: import.meta.env.VITE_IDENTITY_BASE_URL || 'https://cug-identity.tradesea.ai',
  CONNECTION_USER_ID: import.meta.env.VITE_CONNECTION_USER_ID || 'DEzlxWIZlRSv9doFg6JpZKpLVVBYTzg2ODUxomV1u0tVUFhPODY4NTFfTU4yV083Q1NLTjZERzdCU6Fkg6Jzbqh0cmFkZXNlYaNmY22odHJhZGVzZWGiaWKodHJhZGVzZWE',
  CONNECTION_GROUP_ID: import.meta.env.VITE_CONNECTION_GROUP_ID || '3610143d1e3bdd63f96834efc28ed195ad2f347f9e2887a371df702cf6bed2ad',
  CURRENCY_CODE: import.meta.env.VITE_DEFAULT_CURRENCY_CODE || 'USD',
  ACCESS_TOKEN: import.meta.env.VITE_ACCESS_TOKEN || '',
  REFRESH_TOKEN: import.meta.env.VITE_REFRESH_TOKEN || ''
} as const

const DEFAULT_SYMBOL: SymbolInfo = { 
  ticker: 'COMEX:GC', 
  pricePrecision: 2, 
  volumePrecision: 0 
}

const DEFAULT_PERIOD: Period = { 
  type: 'minute', 
  span: 1 
}

const RESOLUTION_TO_PERIOD: Record<string, Period> = {
  '1': { type: 'minute', span: 1 },
  '5': { type: 'minute', span: 5 },
  '15': { type: 'minute', span: 15 },
  '60': { type: 'hour', span: 1 },
  '240': { type: 'hour', span: 4 },
  '1D': { type: 'day', span: 1 },
  '1W': { type: 'week', span: 1 },
  '1M': { type: 'month', span: 1 }
}

// ============================================================================
// Authentication
// ============================================================================

function bootstrapTokensFromEnv (): void {
  const existingToken = getAccessToken()
  if (existingToken && existingToken.length > 0) return
  if (ENV.ACCESS_TOKEN.length === 0) return

  storeTokens({
    accessToken: ENV.ACCESS_TOKEN,
    refreshToken: ENV.REFRESH_TOKEN.length > 0 ? ENV.REFRESH_TOKEN : (getRefreshToken() ?? undefined)
  })
}

function resolveAccessToken (): string | null {
  const token = getAccessToken()
  if (token && token.length > 0) return token
  if (ENV.ACCESS_TOKEN.length > 0) return ENV.ACCESS_TOKEN
  return null
}

async function refreshAccessToken (): Promise<string | null> {
  const refreshToken = getRefreshToken()
  if (!refreshToken || refreshToken.length === 0) return null

  try {
    const response = await fetch(`${ENV.IDENTITY_URL}/v1/login/refresh`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${refreshToken}`
      }
    })
    
    if (!response.ok) return null

    const payload = await response.json()
    const tokenData = payload?.data ?? payload ?? {}
    const nextAccessToken = tokenData.accessToken

    if (typeof nextAccessToken !== 'string' || nextAccessToken.length === 0) {
      return null
    }

    storeTokens({
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      accessTokenValidityInMillis: tokenData.accessTokenValidityInMillis,
      refreshTokenValidityInMillis: tokenData.refreshTokenValidityInMillis
    })

    return nextAccessToken
  } catch {
    return null
  }
}

// ============================================================================
// Data Feed
// ============================================================================

function createDataFeed () {
  return new TradiumDatafeed({
    udfUrl: ENV.MARKET_DATA_URL,
    wsUrl: ENV.MARKET_DATA_WS,
    connectionUserId: ENV.CONNECTION_USER_ID,
    connectionGroupId: ENV.CONNECTION_GROUP_ID,
    defaultCurrencyCode: ENV.CURRENCY_CODE,
    getAccessToken: resolveAccessToken,
    onRefreshToken: refreshAccessToken,
    debug: true,
    barsPerRequest: 300,
    onAuthFailure: (info: any) => console.warn('[Auth] Failure:', info)
  })
}

function periodToFeedPeriod (p: Period): { multiplier: number; timespan: string } {
  return { multiplier: p.span, timespan: p.type }
}

function createDataLoader (feed: any): DataLoader {
  return {
    getBars (params: DataLoaderGetBarsParams) {
      const feedPeriod = periodToFeedPeriod(params.period)
      const now = Date.now()
      const yearMs = 365 * 24 * 60 * 60 * 1000

      let from: number
      let to: number
      
      if (params.type === 'forward' && params.timestamp != null) {
        from = params.timestamp - yearMs
        to = params.timestamp
      } else if (params.type === 'backward' && params.timestamp != null) {
        from = params.timestamp
        to = params.timestamp + yearMs
      } else {
        from = now - yearMs
        to = now
      }

      feed.getHistoryKLineData(params.symbol, feedPeriod, from, to)
        .then((bars: KLineData[]) => {
          const more = { forward: bars.length > 0 }
          params.callback(bars, more)
        })
        .catch((err: any) => {
          console.error('[DataLoader] getBars error:', err)
          params.callback([])
        })
    },

    subscribeBar (params: DataLoaderSubscribeBarParams) {
      const feedPeriod = periodToFeedPeriod(params.period)
      feed.subscribe(params.symbol, feedPeriod, (bar: KLineData) => {
        params.callback(bar)
      })
    },

    unsubscribeBar (params: DataLoaderUnsubscribeBarParams) {
      const feedPeriod = periodToFeedPeriod(params.period)
      feed.unsubscribe(params.symbol, feedPeriod)
    }
  }
}

// ============================================================================
// Chart Application
// ============================================================================

interface ChartApp {
  chart: ReturnType<typeof init>
  tvCompact: TVCompactInstance
  feed: any
  destroy: () => void
}

let app: ChartApp | null = null

async function createChartApp (): Promise<ChartApp | null> {
  const chart = init('chart', { 
    zoomAnchor: 'last_bar',
    layout: {
      basicParams: {
        barSpaceLimitMax: 400
      }
    }
  })
  if (!chart) return null

  window.kline = chart;

  chart.overrideXAxis({
    createTicks: ({ bounding, defaultTicks }) => {
      if (defaultTicks.length < 2) return defaultTicks
      const minSpacing = bounding.width / 40
      const currentSpacing = defaultTicks.length > 1 
        ? Math.abs(defaultTicks[1].coord - defaultTicks[0].coord) 
        : minSpacing
      if (currentSpacing <= minSpacing) return defaultTicks
      const additionalTicks: typeof defaultTicks = []
      for (let i = 0; i < defaultTicks.length - 1; i++) {
        const curr = defaultTicks[i]
        const next = defaultTicks[i + 1]
        const midCoord = (curr.coord + next.coord) / 2
        additionalTicks.push({
          coord: midCoord,
          value: '',
          text: ''
        })
      }
      return [...defaultTicks, ...additionalTicks].sort((a, b) => a.coord - b.coord)
    }
  })

  const feed = createDataFeed()
  const dataLoader = createDataLoader(feed)

  const tvCompact = setupTVCompact({
    chart,
    config: {
      connectionUserId: ENV.CONNECTION_USER_ID,
      connectionGroupId: ENV.CONNECTION_GROUP_ID,
      currencyCode: ENV.CURRENCY_CODE,
      baseUrl: ENV.MARKET_DATA_URL,
      getAccessToken: resolveAccessToken
    }
  })

  chart.setDataLoader(dataLoader)
  chart.setStyles(styles)

  await tvCompact.onSymbolChange(DEFAULT_SYMBOL.ticker)
  chart.setSymbol(DEFAULT_SYMBOL)
  chart.setPeriod(DEFAULT_PERIOD)

  // Add custom spread highlight indicator (highlights bars with spread > 10)
  // chart.createIndicator('SPREAD_HIGHLIGHT', { pane: 'candle_pane' })

  // Add Bollinger Bands indicator
  // chart.createIndicator('BOLLINGER_BAND', { pane: {id: 'candle_pane'} })

  // Add Pivot Point Standard indicator (pivot back 5)
  // chart.createIndicator('PIVOT_POINT', { pane: {id: 'candle_pane'} })

  return {
    chart,
    tvCompact,
    feed,
    destroy: () => {
      tvCompact.cleanup()
      dispose('chart')
    }
  }
}

// ============================================================================
// UI Event Handlers
// ============================================================================

function setupSymbolSearch (feed: any, onSymbolSelect: (symbol: SymbolInfo) => void): void {
  const symbolInput = document.getElementById('symbol-input') as HTMLInputElement
  const symbolResults = document.getElementById('symbol-results')!
  let searchTimeout: ReturnType<typeof setTimeout> | null = null

  symbolInput.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout)
    
    const query = symbolInput.value.trim()
    if (!query) {
      symbolResults.style.display = 'none'
      return
    }
    
    searchTimeout = setTimeout(async () => {
      const results = await feed.searchSymbols(query)
      renderSearchResults(results)
    }, 300)
  })

  symbolInput.addEventListener('focus', () => {
    if (symbolResults.children.length > 0) {
      symbolResults.style.display = 'block'
    }
  })

  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#symbol-search')) {
      symbolResults.style.display = 'none'
    }
  })

  function renderSearchResults (results: any[]): void {
    symbolResults.innerHTML = ''
    
    if (!results.length) {
      symbolResults.style.display = 'none'
      return
    }
    
    results.forEach((item: any) => {
      const div = document.createElement('div')
      div.className = 'symbol-item'
      div.innerHTML = `<span class="ticker">${item.ticker}</span><span class="name">${item.name || ''}</span>`
      
      div.addEventListener('click', () => {
        symbolInput.value = item.ticker
        symbolResults.style.display = 'none'
        
        onSymbolSelect({
          ticker: item.ticker,
          pricePrecision: item.pricePrecision ?? 2,
          volumePrecision: item.volumePrecision ?? 0
        })
      })
      
      symbolResults.appendChild(div)
    })
    
    symbolResults.style.display = 'block'
  }
}

function setupPeriodSelector (onPeriodChange: (period: Period) => void): void {
  const periodSelect = document.getElementById('period-select') as HTMLSelectElement
  
  periodSelect.addEventListener('change', () => {
    const period = RESOLUTION_TO_PERIOD[periodSelect.value]
    if (period) {
      onPeriodChange(period)
    }
  })
}

// ============================================================================
// Application Bootstrap
// ============================================================================

async function bootstrap (): Promise<void> {
  bootstrapTokensFromEnv()
  
  app = await createChartApp()
  if (!app) {
    console.error('[App] Failed to initialize chart')
    return
  }

  setupSymbolSearch(app.feed, async (symbol) => {
    if (!app) return
    await app.tvCompact.onSymbolChange(symbol.ticker)
    app.chart?.setSymbol(symbol)
  })

  setupPeriodSelector((period) => {
    app?.chart?.setPeriod(period)
  })
}

bootstrap()

// ============================================================================
// Hot Module Replacement
// ============================================================================

if (import.meta.hot) {
  import.meta.hot.accept(async () => {
    if (app) {
      app.destroy()
      setSymbolMetadata(null)
      
      const chartEl = document.getElementById('chart')!
      chartEl.removeAttribute('k-line-chart-id')
      chartEl.innerHTML = ''
    }
    
    app = await createChartApp()
    if (app) {
      setupSymbolSearch(app.feed, async (symbol) => {
        if (!app) return
        await app.tvCompact.onSymbolChange(symbol.ticker)
        app.chart?.setSymbol(symbol)
      })
      
      setupPeriodSelector((period) => {
        app?.chart?.setPeriod(period)
      })
    }
  })
}
