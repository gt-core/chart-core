/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MARKET_DATA_BASE_URL: string
  readonly VITE_MARKET_DATA_WS_URL: string
  readonly VITE_IDENTITY_BASE_URL: string
  readonly VITE_CONNECTION_USER_ID: string
  readonly VITE_CONNECTION_GROUP_ID: string
  readonly VITE_DEFAULT_CURRENCY_CODE: string
  readonly VITE_ACCESS_TOKEN: string
  readonly VITE_REFRESH_TOKEN: string
  readonly VITE_USER_MANAGEMENT_BASE_URL: string
  readonly VITE_EXTERNAL_USER_MANAGEMENT_BASE_URL: string
  readonly VITE_TRADES_WRITE_BASE_URL: string
  readonly VITE_TRADES_READ_BASE_URL: string
  readonly VITE_DISCOVERY_BASE_URL: string
  readonly VITE_UNIFIED_STREAM_WS_URL: string
  readonly VITE_CENTRALISED_WS_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
