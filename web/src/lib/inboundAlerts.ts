/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { useEffect, useRef, useState } from 'react';
import { useTrades } from './api';

const BASE_TITLE = 'Appraiser';
export const SOUND_KEY = 'rta.inboundSound';

export function soundEnabled(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
}
export function setSoundEnabled(on: boolean): void {
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* per-viewer convenience only */ }
}

/** Very short, quiet two-note chime (WebAudio, ~0.25 s, low gain). */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t0 = ctx.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const s = t0 + i * 0.11;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.05, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.12);
      o.connect(g).connect(ctx.destination);
      o.start(s); o.stop(s + 0.13);
    }
    setTimeout(() => void ctx.close(), 600);
  } catch { /* audio blocked: ignore */ }
}

/**
 * Open inbound trade count for the tab badge; while the page is not focused the browser tab title
 * shows "(n) Appraiser" and a new trade plays a quiet chime. Focusing the page clears both.
 */
export function useInboundAlerts(): number {
  const q = useTrades({ direction: 'inbound', limit: 200 });
  const count = (q.data?.rows ?? []).filter((r) => r.trade.isActive).length;
  const [focused, setFocused] = useState(() => !document.hidden && document.hasFocus());
  const seenWhileFocused = useRef(count);
  const prev = useRef<number | null>(null);

  useEffect(() => {
    const upd = () => setFocused(!document.hidden && document.hasFocus());
    window.addEventListener('focus', upd); window.addEventListener('blur', upd);
    document.addEventListener('visibilitychange', upd);
    return () => { window.removeEventListener('focus', upd); window.removeEventListener('blur', upd); document.removeEventListener('visibilitychange', upd); };
  }, []);

  useEffect(() => {
    if (!q.data) return;
    if (focused) seenWhileFocused.current = count;
    if (prev.current != null && count > prev.current && !focused && soundEnabled()) playChime();
    prev.current = count;
  }, [count, focused, q.data]);

  useEffect(() => {
    document.title = !focused && count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  }, [count, focused]);

  return count;
}
