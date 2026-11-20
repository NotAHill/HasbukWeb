// Horizontal swipe detection with drag feedback. Vertical movement is left to
// the browser (the element should have `touch-action: pan-y`).

const MIN_DISTANCE = 60; // px
const MIN_FLICK_DISTANCE = 30; // px, for fast flicks
const FLICK_VELOCITY = 0.5; // px/ms

export function attachSwipe(el, onSwipe) {
  let drag = null;
  let suppressClick = false;

  const reset = () => {
    el.classList.remove('dragging');
    el.style.transform = '';
    el.style.opacity = '';
    drag = null;
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('select, input')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), axis: null, dx: 0 };
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.axis && Math.hypot(dx, dy) > 10) {
      drag.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      if (drag.axis === 'x') {
        el.setPointerCapture?.(e.pointerId);
        el.classList.add('dragging');
      }
    }
    if (drag.axis === 'x') {
      drag.dx = dx;
      el.style.transform = `translateX(${dx * 0.5}px)`;
      el.style.opacity = String(Math.max(0.5, 1 - Math.abs(dx) / 600));
    }
  });

  el.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { axis, dx, t } = drag;
    const velocity = Math.abs(dx) / Math.max(1, performance.now() - t);
    const swiped = axis === 'x'
      && (Math.abs(dx) >= MIN_DISTANCE || (Math.abs(dx) >= MIN_FLICK_DISTANCE && velocity >= FLICK_VELOCITY));
    if (axis === 'x') suppressClick = true;
    reset();
    if (swiped) {
      const direction = dx < 0 ? 'left' : 'right';
      const moved = onSwipe(direction);
      if (moved !== false) slideIn(el, direction);
    }
  });

  el.addEventListener('pointercancel', reset);

  // A drag ends with a click on whatever was under the finger; swallow it.
  el.addEventListener('click', (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
    }
  }, true);
  el.addEventListener('pointerdown', () => { suppressClick = false; }, true);
}

function slideIn(el, direction) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.classList.add('dragging');
  el.style.transform = `translateX(${direction === 'left' ? 40 : -40}px)`;
  el.style.opacity = '0';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.remove('dragging');
      el.style.transform = '';
      el.style.opacity = '';
    });
  });
}
