import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../../theme.js';

const DURATION = 280;

// Slide-up sheet anchored to the bottom edge. Tap the scrim, tap the grab
// handle, drag the handle down >60px, or press hardware back to dismiss.
//
// Mount it conditionally ({open && <BottomSheet .../>}) rather than passing a
// `visible` prop: the slide-in is driven by the mount, and `onClose` fires only
// after the slide-out finishes so the parent unmounts on the last frame.
//
// `children` and `footer` may each be a node, or a function receiving `close`
// so content can trigger the animated dismissal instead of a hard unmount.
export default function BottomSheet({ onClose, title, children, footer, zIndex = 300 }) {
  const { colors, typography, spacing } = useTheme();
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const touchStartY = useRef(null);

  // One frame at translateY(100%) before flipping to 0%, so the transition
  // has a start value to animate from.
  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 20);
    return () => clearTimeout(id);
  }, []);

  const close = useCallback(() => {
    setClosing((c) => {
      if (c) return c;
      setTimeout(() => onClose(), DURATION);
      return true;
    });
  }, [onClose]);

  // Hardware back closes the sheet and stops the back-stack walk. Ignored
  // mid-slide-out so a second back press doesn't reach the handler beneath.
  useEffect(() => {
    const handler = () => {
      if (closing) return true;
      close();
      return true;
    };
    window.__registerBackHandler?.(handler);
    return () => window.__unregisterBackHandler?.(handler);
  }, [closing, close]);

  const onHandleTouchStart = (e) => { touchStartY.current = e.touches[0].clientY; };
  const onHandleTouchMove = (e) => {
    if (touchStartY.current === null) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (dy > 60) {
      touchStartY.current = null;
      window.callBare('haptic:tap');
      close();
    }
  };

  const open = visible && !closing;

  // Portal to document.body so the fixed scrim escapes any transformed
  // ancestor, which would otherwise become its containing block.
  return createPortal(
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        background: open ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0)',
        transition: `background ${DURATION}ms ease`,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '600px',
          boxSizing: 'border-box',
          background: colors.surface.card,
          color: colors.text.secondary,
          ...typography.body,
          borderTopLeftRadius: '20px',
          borderTopRightRadius: '20px',
          borderTop: `1px solid ${colors.border}`,
          maxHeight: '85vh',
          overflowY: 'auto',
          overflowX: 'hidden',
          WebkitOverflowScrolling: 'touch',
          padding: `0 ${spacing.lg}px calc(env(safe-area-inset-bottom, 0px) + ${spacing.lg}px)`,
          transform: `translateY(${open ? '0%' : '100%'})`,
          transition: `transform ${DURATION}ms cubic-bezier(0.32,0.72,0,1)`,
        }}
      >
        <div
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onClick={close}
          style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px', cursor: 'pointer' }}
        >
          <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: colors.text.muted }} />
        </div>

        {title && (
          <div style={{ ...typography.heading, color: colors.text.primary, textAlign: 'center', margin: `${spacing.sm}px 0 ${spacing.base}px` }}>
            {title}
          </div>
        )}

        {typeof children === 'function' ? children(close) : children}

        {footer && (
          <div style={{ display: 'flex', gap: `${spacing.sm}px`, marginTop: `${spacing.base}px`, justifyContent: 'center' }}>
            {typeof footer === 'function' ? footer(close) : footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
