/**
 * TV-compact zoom anchor behavior:
 * - Command key pressed: zoom anchor set to cursor
 * - Command key released: zoom anchor set to last bar
 */

type ChartInstance = {
  setZoomAnchor: (anchor: 'cursor' | 'last_bar') => void
}

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

  // Return cleanup function
  return () => {
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
  }
}
