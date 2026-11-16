'use client';

import { useEffect } from 'react';

/**
 * Register the branch till service worker once, on the client. Renders nothing. Kept separate from
 * the POS page so the registration is a single, obvious side effect.
 */
export function RegisterServiceWorker(): null {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Only in production: in dev, a service worker caches the shell and fights hot reload.
    if (process.env.NODE_ENV !== 'production') return;
    const register = () => {
      void navigator.serviceWorker.register('/sw.js').catch(() => {
        /* registration is best effort; the till still works online without it */
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);
  return null;
}
