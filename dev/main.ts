import { init, dispose } from '../src/index'
import type { SymbolInfo } from '../src/common/SymbolInfo'
import type { Period } from '../src/common/Period'
import type { DataLoader, DataLoaderGetBarsParams, DataLoaderSubscribeBarParams, DataLoaderUnsubscribeBarParams } from '../src/common/DataLoader'
import type { KLineData } from '../src/common/Data'
import { styles } from './config'
import { getAccessToken, getRefreshToken, storeTokens } from './auth-constants'

declare const TradiumDatafeed: any

const MARKET_DATA_URL = import.meta.env.VITE_MARKET_DATA_BASE_URL || 'https://cug-market-data.tradesea.ai/v1'
const MARKET_DATA_WS = import.meta.env.VITE_MARKET_DATA_WS_URL || 'wss://cug-market-data.tradesea.ai/v1/wss'
const IDENTITY_URL = import.meta.env.VITE_IDENTITY_BASE_URL || 'https://cug-identity.tradesea.ai'
const CONNECTION_USER_ID = import.meta.env.VITE_CONNECTION_USER_ID || 'DEzlxWIZlRSv9doFg6JpZKpLVVBYTzg2ODUxomV1u0tVUFhPODY4NTFfTU4yV083Q1NLTjZERzdCU6Fkg6Jzbqh0cmFkZXNlYaNmY22odHJhZGVzZWGiaWKodHJhZGVzZWE'
const CONNECTION_GROUP_ID = import.meta.env.VITE_CONNECTION_GROUP_ID || '3610143d1e3bdd63f96834efc28ed195ad2f347f9e2887a371df702cf6bed2ad'
const DEFAULT_CURRENCY_CODE = import.meta.env.VITE_DEFAULT_CURRENCY_CODE || 'USD'
const ENV_ACCESS_TOKEN = import.meta.env.VITE_ACCESS_TOKEN || ''
const ENV_REFRESH_TOKEN = import.meta.env.VITE_REFRESH_TOKEN || ''

const DEFAULT_SYMBOL: SymbolInfo = { ticker: 'CME:MES', pricePrecision: 2, volumePrecision: 0 }
const DEFAULT_PERIOD: Period = { type: 'day', span: 1 }

function bootstrapTokensFromEnv (): void {
  const accessToken = getAccessToken()
  const refreshToken = getRefreshToken()
  if (accessToken != null && accessToken.length > 0) return

  if (ENV_ACCESS_TOKEN.length === 0) return

  storeTokens({
    accessToken: ENV_ACCESS_TOKEN,
    refreshToken: ENV_REFRESH_TOKEN.length > 0 ? ENV_REFRESH_TOKEN : (refreshToken ?? undefined)
  })
}

function resolveAccessToken (): string | null {
  const token = getAccessToken()
  if (token != null && token.length > 0) return token
  if (ENV_ACCESS_TOKEN.length > 0) return ENV_ACCESS_TOKEN
  return null
}

async function refreshAccessToken (): Promise<string | null> {
  const refreshToken = getRefreshToken()
  if (refreshToken == null || refreshToken.length === 0) {
    return null
  }

  try {
    const response = await fetch(`${IDENTITY_URL}/v1/login/refresh`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${refreshToken}`
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

bootstrapTokensFromEnv()

const feed = new TradiumDatafeed({
  udfUrl: MARKET_DATA_URL,
  wsUrl: MARKET_DATA_WS,
  connectionUserId: CONNECTION_USER_ID,
  connectionGroupId: CONNECTION_GROUP_ID,
  defaultCurrencyCode: DEFAULT_CURRENCY_CODE,
  getAccessToken: resolveAccessToken,
  onRefreshToken: refreshAccessToken,
  debug: true,
  barsPerRequest: 500,
  onAuthFailure: (info: any) => console.warn('[Auth] failure:', info)
})

function periodToFeedPeriod (p: Period): { multiplier: number, timespan: string } {
  return { multiplier: p.span, timespan: p.type }
}

const dataLoader: DataLoader = {
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
        const more = params.type === 'init' ? { forward: bars.length > 0 } : false
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

let chart: ReturnType<typeof init> = null

function createChart (): void {
  chart = init('chart',{
    // zoomAnchor:'last_bar',
    // zoomEnabled: true,
    // panEnabled: true,
    // crosshairEnabled: true,
    // crosshairColor: 'rgba(255, 255, 255, 0.5)',
    // crosshairWidth: 1,
    // crosshairStyle: 'solid',
    // crosshairType: 'vertical',
    // crosshairLineWidth: 1,
  })

  if (chart === null) return
  chart.setDataLoader(dataLoader)
  chart.setSymbol(DEFAULT_SYMBOL)
  chart.setPeriod(DEFAULT_PERIOD)
  chart.setStyles(styles)
}

// Period mapping
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

// Symbol search UI
let searchTimeout: ReturnType<typeof setTimeout> | null = null
const symbolInput = document.getElementById('symbol-input') as HTMLInputElement
const symbolResults = document.getElementById('symbol-results')!

symbolInput.addEventListener('input', () => {
  if (searchTimeout) clearTimeout(searchTimeout)
  const query = symbolInput.value.trim()
  if (!query) {
    symbolResults.style.display = 'none'
    return
  }
  searchTimeout = setTimeout(async () => {
    const results = await feed.searchSymbols(query)
    renderResults(results)
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

function renderResults (results: any[]) {
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
      const sym: SymbolInfo = {
        ticker: item.ticker,
        pricePrecision: item.pricePrecision ?? 2,
        volumePrecision: item.volumePrecision ?? 0
      }
      chart?.setSymbol(sym)
    })
    symbolResults.appendChild(div)
  })
  symbolResults.style.display = 'block'
}

// Period selector
const periodSelect = document.getElementById('period-select') as HTMLSelectElement
periodSelect.addEventListener('change', () => {
  const period = RESOLUTION_TO_PERIOD[periodSelect.value]
  if (period && chart) {
    chart.setPeriod(period)
  }
})

// Init
createChart()

// HMR
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    dispose('chart')
    document.getElementById('chart')!.removeAttribute('k-line-chart-id')
    document.getElementById('chart')!.innerHTML = ''
    createChart()
  })
}
