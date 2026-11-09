/* Soft cursor aura. Native cursor, selection, keyboard navigation and clicks remain untouched. */
(() => {
  'use strict';
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const toggle = document.querySelector('.motion-toggle');
  let optedOut = false;
  try { optedOut = localStorage.getItem('fuyelist-motion') === 'off'; } catch (_) {}
  let aura = null, glow = null, echo = null, observer = null, activeCard = null;
  let frame = 0, idleTimer = 0, previousTime = 0, tracking = false;
  const target = { x: 0, y: 0 };
  const front = { x: 0, y: 0 };
  const back = { x: 0, y: 0 };
  const enabled = () => !optedOut && !reduced.matches;
  function clearCard() {
    if (!activeCard) return;
    activeCard.removeAttribute('data-cursor-lit');
    activeCard.style.removeProperty('--cursor-x');
    activeCard.style.removeProperty('--cursor-y');
    activeCard = null;
  }
  function hideAura() {
    cancelAnimationFrame(frame);
    clearTimeout(idleTimer);
    frame = 0;
    idleTimer = 0;
    tracking = false;
    previousTime = 0;
    aura?.classList.remove('is-visible');
    clearCard();
  }
  function positionLayers() {
    glow.style.transform = 'translate3d(' + front.x.toFixed(2) + 'px,' + front.y.toFixed(2) + 'px,0)';
    echo.style.transform = 'translate3d(' + back.x.toFixed(2) + 'px,' + back.y.toFixed(2) + 'px,0)';
  }
  function draw(now) {
    frame = 0;
    if (!aura || !tracking || !enabled() || document.hidden) return;
    // Frame-rate independent easing: no bounce or painted lines.
    const delta = previousTime ? Math.min(now - previousTime, 40) : 16.67;
    previousTime = now;
    const frontEase = 1 - Math.exp(-delta / 95);
    const backEase = 1 - Math.exp(-delta / 210);
    front.x += (target.x - front.x) * frontEase;
    front.y += (target.y - front.y) * frontEase;
    back.x += (front.x - back.x) * backEase;
    back.y += (front.y - back.y) * backEase;
    positionLayers();
    const remaining = Math.hypot(target.x - front.x, target.y - front.y) + Math.hypot(front.x - back.x, front.y - back.y);
    if (remaining > .15) frame = requestAnimationFrame(draw);
    else previousTime = 0;
  }
  function pointerMove(event) {
    if (!enabled() || !finePointer.matches || event.pointerType !== 'mouse' || document.hidden || !aura) return;
    if (event.buttons || event.target.closest('input, textarea, select, dialog, [contenteditable="true"]')) { hideAura(); return; }
    target.x = event.clientX;
    target.y = event.clientY;
    const jumped = Math.hypot(target.x - front.x, target.y - front.y) > 600;
    if (!tracking || jumped) {
      front.x = back.x = target.x;
      front.y = back.y = target.y;
      positionLayers();
    }
    tracking = true;
    aura.classList.add('is-visible');
    const card = event.target.closest('.case, .project, .code-card');
    if (card !== activeCard) { clearCard(); activeCard = card; }
    if (activeCard) {
      const rect = activeCard.getBoundingClientRect();
      activeCard.setAttribute('data-cursor-lit', '');
      activeCard.style.setProperty('--cursor-x', (event.clientX - rect.left) + 'px');
      activeCard.style.setProperty('--cursor-y', (event.clientY - rect.top) + 'px');
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(hideAura, 1600);
    if (!frame) frame = requestAnimationFrame(draw);
  }
  function applyPreference() {
    root.dataset.motion = enabled() ? 'on' : 'off';
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(enabled()));
      toggle.disabled = reduced.matches;
      toggle.textContent = reduced.matches ? '已减少动效' : enabled() ? '动效开' : '动效关';
      toggle.title = reduced.matches ? '遵循系统的减少动态效果设置' : '切换轻动效与鼠标柔光';
    }
    observer?.disconnect();
    document.querySelectorAll('.ui-reveal').forEach(el => el.classList.remove('ui-reveal'));
    hideAura();
    if (!enabled() || !finePointer.matches) {
      aura?.remove();
      aura = glow = echo = null;
    } else if (!aura) {
      aura = document.createElement('div');
      aura.className = 'cursor-aura';
      aura.setAttribute('aria-hidden', 'true');
      glow = document.createElement('span');
      glow.className = 'cursor-aura-glow';
      echo = document.createElement('span');
      echo.className = 'cursor-aura-echo';
      aura.append(echo, glow);
      document.body.append(aura);
    }
    if (enabled() && 'IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('ui-reveal');
          observer.unobserve(entry.target);
        });
      }, { threshold: .08 });
      document.querySelectorAll('.intro, .hero, .muse-banner, .invite').forEach(el => observer.observe(el));
    }
  }
  toggle?.addEventListener('click', () => {
    optedOut = !optedOut;
    try { localStorage.setItem('fuyelist-motion', optedOut ? 'off' : 'on'); } catch (_) {}
    applyPreference();
  });
  reduced.addEventListener('change', applyPreference);
  finePointer.addEventListener('change', applyPreference);
  document.addEventListener('pointermove', pointerMove, { passive: true });
  document.addEventListener('pointerleave', hideAura);
  document.addEventListener('pointerdown', event => { if (event.target.closest('input, textarea, select, [contenteditable="true"]')) hideAura(); });
  document.addEventListener('keydown', event => { if (['Tab', 'Escape'].includes(event.key)) hideAura(); });
  document.addEventListener('visibilitychange', hideAura);
  window.addEventListener('blur', hideAura);
  window.addEventListener('resize', hideAura, { passive: true });
  window.addEventListener('scroll', clearCard, { passive: true });
  window.addEventListener('pagehide', hideAura);
  applyPreference();
})();
