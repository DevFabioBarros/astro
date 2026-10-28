export function focusPlanetNavigationButton(host: HTMLElement, bodyId: string): boolean {
  const rail = host.closest(".astro-shell")?.querySelector<HTMLElement>(".planet-navigation");
  const button = [...(rail?.querySelectorAll<HTMLButtonElement>("[data-body-id]") ?? [])].find((candidate) => candidate.dataset.bodyId === bodyId);
  if (!rail || !button) return false;

  const clips = (value: string) => ["hidden", "clip", "auto", "scroll"].includes(value);
  const ancestors: Array<{ left?: number; right?: number; top?: number; bottom?: number }> = [];
  let left = 0, right = window.innerWidth;
  for (let ancestor = button.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
    const innerLeft = bounds.left + ancestor.clientLeft, innerTop = bounds.top + ancestor.clientTop;
    const clipX = clips(style.overflowX), clipY = clips(style.overflowY);
    if (clipX) { left = Math.max(left, innerLeft); right = Math.min(right, innerLeft + ancestor.clientWidth); }
    ancestors.push({ ...(clipX ? { left: innerLeft, right: innerLeft + ancestor.clientWidth } : {}), ...(clipY ? { top: innerTop, bottom: innerTop + ancestor.clientHeight } : {}) });
  }
  const viewport = button.getBoundingClientRect();
  if (viewport.top < 0 || viewport.bottom > window.innerHeight || right - left < viewport.right - viewport.left) return false;
  if (ancestors.some((bounds) => bounds.top !== undefined && bounds.bottom !== undefined && (viewport.top < bounds.top || viewport.bottom > bounds.bottom))) return false;
  if (viewport.left < left) rail.scrollLeft -= left - viewport.left;
  else if (viewport.right > right) rail.scrollLeft += viewport.right - right;
  const revealed = button.getBoundingClientRect();
  if (revealed.left < left || revealed.right > right) return false;

  button.focus({ preventScroll: true });

  const visible = button.getBoundingClientRect();
  return document.activeElement === button && visible.left >= 0 && visible.right <= window.innerWidth
    && visible.top >= 0 && visible.bottom <= window.innerHeight
    && ancestors.every((bounds) => (bounds.left === undefined || bounds.right !== undefined && visible.left >= bounds.left && visible.right <= bounds.right)
      && (bounds.top === undefined || bounds.bottom !== undefined && visible.top >= bounds.top && visible.bottom <= bounds.bottom));
}
