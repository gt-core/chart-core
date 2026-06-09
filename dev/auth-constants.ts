export const AUTH_STORAGE_KEYS = {
  accessToken: 'tradesea_access_token',
  refreshToken: 'tradesea_refresh_token',
  accessTokenExpiry: 'tradesea_access_token_expiry',
  refreshTokenExpiry: 'tradesea_refresh_token_expiry'
} as const

export interface RefreshTokenData {
  accessToken?: string
  refreshToken?: string
  accessTokenValidityInMillis?: number
  refreshTokenValidityInMillis?: number
}

export function getAccessToken (): string | null {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEYS.accessToken)
  } catch {
    return null
  }
}

export function getRefreshToken (): string | null {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEYS.refreshToken)
  } catch {
    return null
  }
}

export function storeTokens (data: RefreshTokenData): void {
  const now = Date.now()
  try {
    if (data.accessToken) {
      localStorage.setItem(AUTH_STORAGE_KEYS.accessToken, data.accessToken)
      if (data.accessTokenValidityInMillis != null) {
        localStorage.setItem(
          AUTH_STORAGE_KEYS.accessTokenExpiry,
          String(now + data.accessTokenValidityInMillis)
        )
      }
    }
    if (data.refreshToken) {
      localStorage.setItem(AUTH_STORAGE_KEYS.refreshToken, data.refreshToken)
      if (data.refreshTokenValidityInMillis != null) {
        localStorage.setItem(
          AUTH_STORAGE_KEYS.refreshTokenExpiry,
          String(now + data.refreshTokenValidityInMillis)
        )
      }
    }
  } catch {
    // Ignore localStorage errors for local dev mode.
  }
}
