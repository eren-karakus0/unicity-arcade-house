/**
 * Motion preference — the OS setting, with an explicit per-site override.
 * Players who globally disable Windows/macOS animations for speed can still
 * opt IN to the hall's motion here: the override sets `data-motion="on"` on
 * <html>, which every `prefers-reduced-motion` block in app.css respects via
 * `:root:not([data-motion='on'])`, and the JS-driven effects check
 * `prefersReducedMotion()` instead of reading matchMedia directly.
 */

const KEY = 'arcade:motion';

export function motionOverride(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function systemPrefersReduced(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The single source of truth for "should this effect animate?". */
export function prefersReducedMotion(): boolean {
  return systemPrefersReduced() && !motionOverride();
}

export function setMotionOverride(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — the attribute still applies for this page */
  }
  applyMotionAttr();
  // Let JS-driven effects (typewriter, count-ups) react without a reload.
  window.dispatchEvent(new Event('arcade:motion'));
}

/** Stamp the stored preference onto <html> — call once at boot. */
export function applyMotionAttr(): void {
  if (motionOverride()) document.documentElement.setAttribute('data-motion', 'on');
  else document.documentElement.removeAttribute('data-motion');
}
