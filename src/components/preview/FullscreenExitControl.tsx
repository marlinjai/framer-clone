// Small floating "Exit fullscreen" control for the chrome-free preview. It
// shows on any pointer movement (the top edge included), stays while hovered
// or focused, and fades out after two seconds of stillness so the page is
// seen alone. The fade is short, ease-out, and off for reduced motion.
'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Minimize2 } from 'lucide-react';

export const EXIT_CONTROL_HIDE_MS = 2000;

export interface FullscreenExitControlProps {
  onExit: () => void;
}

const FullscreenExitControl = ({ onExit }: FullscreenExitControlProps) => {
  // Visible right after entering, so the way out is known before it fades.
  const [visible, setVisible] = useState(true);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!held.current) setVisible(false);
    }, EXIT_CONTROL_HIDE_MS);
  }, []);

  const reveal = useCallback(() => {
    setVisible(true);
    arm();
  }, [arm]);

  useEffect(() => {
    arm();
    window.addEventListener('mousemove', reveal);
    window.addEventListener('pointerdown', reveal);
    return () => {
      window.removeEventListener('mousemove', reveal);
      window.removeEventListener('pointerdown', reveal);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [arm, reveal]);

  const hold = () => {
    held.current = true;
    setVisible(true);
  };
  const release = () => {
    held.current = false;
    arm();
  };

  return (
    <button
      type="button"
      onClick={onExit}
      onMouseEnter={hold}
      onMouseLeave={release}
      onFocus={hold}
      onBlur={release}
      aria-label="Exit fullscreen"
      title="Exit fullscreen (Esc)"
      data-fullscreen-exit=""
      data-visible={visible ? '' : undefined}
      className={`fixed right-4 top-4 z-50 flex items-center gap-1.5 rounded-full bg-gray-900/90 px-3 py-1.5 text-xs text-gray-100 shadow-lg backdrop-blur transition-opacity duration-150 ease-out motion-reduce:transition-none hover:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
    >
      <Minimize2 size={14} />
      <span>Exit fullscreen</span>
    </button>
  );
};

export default FullscreenExitControl;
