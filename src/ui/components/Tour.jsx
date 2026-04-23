import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../theme.js';

const TourContext = createContext(null);

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used inside <TourProvider>');
  return ctx;
}

export function TourProvider({ children }) {
  const [slides, setSlides] = useState(null);
  const [index, setIndex] = useState(0);
  const onFinishRef = useRef(null);

  const start = useCallback((slidesArray, opts) => {
    setSlides(slidesArray);
    setIndex(0);
    onFinishRef.current = opts?.onFinish || null;
  }, []);

  const finish = useCallback(() => {
    setSlides(null);
    setIndex(0);
    if (onFinishRef.current) {
      try { onFinishRef.current(); } catch (e) { /* swallow */ }
      onFinishRef.current = null;
    }
  }, []);

  const next = useCallback(() => {
    setIndex((i) => {
      if (!slides) return i;
      if (i + 1 >= slides.length) {
        finish();
        return i;
      }
      return i + 1;
    });
  }, [slides, finish]);

  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  const value = {
    slides,
    index,
    currentSlide: (slides && slides[index]) || null,
    start,
    next,
    prev,
    finish,
    skip: finish,
  };

  return (
    <TourContext.Provider value={value}>
      {children}
      {slides && <TourSpotlight />}
    </TourContext.Provider>
  );
}

const PADDING = 8;

function TourSpotlight() {
  const { colors, typography, spacing, radius } = useTheme();
  const { currentSlide, index, slides, next, prev, skip } = useTour();
  const [rect, setRect] = useState(null);

  // Drive navigation when slide changes. Slides call window.__pearTourNavigate(target).
  useEffect(() => {
    if (!currentSlide) return;
    if (currentSlide.navigate) {
      try { currentSlide.navigate(); } catch (e) { console.warn('[tour] navigate failed:', e); }
    }
  }, [currentSlide]);

  // Measure target rect; poll so we adapt to layout shifts (tab switches, scroll, etc).
  useEffect(() => {
    if (!currentSlide?.targetId) {
      setRect(null);
      return;
    }
    let stopped = false;
    let scrolled = false;

    function measure() {
      if (stopped) return;
      const el = document.querySelector(`[data-tour-id="${currentSlide.targetId}"]`);
      if (el) {
        if (!scrolled) {
          scrolled = true;
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        }
        const r = el.getBoundingClientRect();
        setRect((prev) => {
          if (prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height) return prev;
          return { top: r.top, left: r.left, width: r.width, height: r.height };
        });
      } else {
        setRect(null);
      }
    }

    measure();
    const interval = setInterval(measure, 150);
    window.addEventListener('resize', measure);
    return () => {
      stopped = true;
      clearInterval(interval);
      window.removeEventListener('resize', measure);
    };
  }, [currentSlide]);

  if (!currentSlide) return null;

  const total = slides.length;
  const isFirst = index === 0;
  const isLast = index === total - 1;

  const tooltipMaxWidth = 320;
  const tooltipPadding = spacing.base;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 360;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 640;

  // Tooltip placement: below target if there's room, else above, else center.
  let tooltipStyle;
  const targetCenterX = rect ? rect.left + rect.width / 2 : viewportWidth / 2;
  if (rect) {
    const spaceBelow = viewportHeight - (rect.top + rect.height);
    const spaceAbove = rect.top;
    const tooltipWidth = Math.min(tooltipMaxWidth, viewportWidth - tooltipPadding * 2);
    const left = Math.max(tooltipPadding, Math.min(viewportWidth - tooltipWidth - tooltipPadding, targetCenterX - tooltipWidth / 2));
    if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
      tooltipStyle = { top: `${rect.top + rect.height + 12}px`, left: `${left}px`, width: `${tooltipWidth}px` };
    } else {
      tooltipStyle = { bottom: `${viewportHeight - rect.top + 12}px`, left: `${left}px`, width: `${tooltipWidth}px` };
    }
  } else {
    const tooltipWidth = Math.min(tooltipMaxWidth, viewportWidth - tooltipPadding * 2);
    tooltipStyle = {
      top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: `${tooltipWidth}px`,
    };
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none' }}>
      {/* Dim overlay with a hole for the target */}
      {rect ? (
        <div
          style={{
            position: 'fixed',
            top: rect.top - PADDING,
            left: rect.left - PADDING,
            width: rect.width + PADDING * 2,
            height: rect.height + PADDING * 2,
            borderRadius: `${radius.md}px`,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.72)',
            border: `2px solid ${colors.primary}`,
            pointerEvents: 'auto',
            transition: 'top 200ms ease, left 200ms ease, width 200ms ease, height 200ms ease',
          }}
        />
      ) : (
        <div
          style={{
            position: 'fixed', inset: 0,
            backgroundColor: 'rgba(0,0,0,0.72)',
            pointerEvents: 'auto',
          }}
        />
      )}

      {/* Tooltip card */}
      <div
        style={{
          position: 'fixed',
          ...tooltipStyle,
          backgroundColor: colors.surface.card,
          border: `1px solid ${colors.border}`,
          borderRadius: `${radius.lg}px`,
          padding: `${spacing.base}px`,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
          zIndex: 1001,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: `${spacing.xs}px` }}>
          <span style={{ ...typography.caption, color: colors.text.muted }}>{index + 1} of {total}</span>
          <button
            onClick={() => { window.callBare('haptic:tap'); skip(); }}
            aria-label="Skip tutorial"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              ...typography.caption, color: colors.text.muted, padding: `${spacing.xs}px`,
            }}
          >
            Skip
          </button>
        </div>
        <h3 style={{ ...typography.subheading, fontWeight: '700', color: colors.text.primary, margin: 0, marginBottom: `${spacing.xs}px` }}>
          {currentSlide.title}
        </h3>
        <p style={{ ...typography.body, color: colors.text.secondary, margin: 0, marginBottom: `${spacing.base}px`, lineHeight: '1.45' }}>
          {currentSlide.body}
        </p>
        <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
          {!isFirst && (
            <button
              onClick={() => { window.callBare('haptic:tap'); prev(); }}
              aria-label="Previous"
              style={{
                flex: 1,
                padding: `${spacing.sm}px`,
                border: `1px solid ${colors.border}`,
                borderRadius: `${radius.md}px`,
                background: 'transparent',
                color: colors.text.secondary,
                cursor: 'pointer',
                ...typography.body,
              }}
            >
              Back
            </button>
          )}
          <button
            onClick={() => { window.callBare('haptic:tap'); next(); }}
            aria-label={isLast ? 'Finish tutorial' : 'Next'}
            style={{
              flex: 1,
              padding: `${spacing.sm}px`,
              border: 'none',
              borderRadius: `${radius.md}px`,
              backgroundColor: colors.primary,
              color: '#FFFFFF',
              cursor: 'pointer',
              ...typography.body,
              fontWeight: '600',
            }}
          >
            {isLast ? (currentSlide.cta || 'Get Started') : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
