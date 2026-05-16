import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

type Position = { x: number; y: number };

// Lightweight pointer-based drag. Returns an offset (translate) plus the
// handler props you attach to the drag handle (e.g. a window's title bar).
//
//   const { pos, handleProps } = useDraggable();
//   <div style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}>
//     <header {...handleProps}>drag me</header>
//   </div>
export function useDraggable(initial: Position = { x: 0, y: 0 }) {
  const [pos, setPos] = useState<Position>(initial);
  const start = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      // Ignore non-primary buttons and clicks on interactive children.
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('button, input, select, textarea, a')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = {
        x: e.clientX,
        y: e.clientY,
        ox: pos.x,
        oy: pos.y,
      };
    },
    [pos],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!start.current) return;
    setPos({
      x: start.current.ox + (e.clientX - start.current.x),
      y: start.current.oy + (e.clientY - start.current.y),
    });
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    start.current = null;
  }, []);

  return {
    pos,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      style: {
        cursor: 'grab',
        touchAction: 'none' as const,
        userSelect: 'none' as const,
      },
    },
  };
}
