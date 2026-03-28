import { useMemo, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerLeave: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void
}

export function useLongPress(onLongPress: () => void, delay = 520): LongPressHandlers {
  const timerRef = useRef<number | null>(null)
  const pressRef = useRef(false)

  return useMemo(
    () => ({
      onPointerDown: () => {
        pressRef.current = true
        window.clearTimeout(timerRef.current ?? undefined)
        timerRef.current = window.setTimeout(() => {
          if (pressRef.current) {
            onLongPress()
          }
        }, delay)
      },
      onPointerUp: () => {
        pressRef.current = false
        window.clearTimeout(timerRef.current ?? undefined)
        timerRef.current = null
      },
      onPointerLeave: () => {
        pressRef.current = false
        window.clearTimeout(timerRef.current ?? undefined)
        timerRef.current = null
      },
      onContextMenu: (event) => {
        event.preventDefault()
        onLongPress()
      },
    }),
    [delay, onLongPress],
  )
}
