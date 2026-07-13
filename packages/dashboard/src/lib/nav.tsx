/**
 * Clean path navigation (no `#`). The SPA rewrite in vercel.json serves
 * index.html for deep links like /fairness; in-app moves use pushState so
 * nothing reloads. Lives in lib/ so pages can link without importing App
 * (which imports the pages — a cycle otherwise).
 */
import type { AnchorHTMLAttributes } from 'react';

export function currentPath(): string {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

/** In-app navigation: pushState + notify the router (no full reload). */
export function go(path: string): void {
  if (path === currentPath()) return;
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** An <a> that navigates in-app but stays a real link (copyable, middle-click). */
export function NavLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { href, onClick, ...rest } = props;
  return (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(href);
      }}
      {...rest}
    />
  );
}
