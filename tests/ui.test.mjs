import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(root + name, 'utf8');
const motion = read('dist/ui/motion.js');

function harness({ reduce = false, fine = true, saved = null, storageFails = false } = {}) {
  const events = new Map(), windowEvents = new Map(), frames = new Map(), timers = new Map();
  let serial = 0;
  class Element {
    constructor() {
      this.children = []; this.attrs = {}; this.events = {}; this.removed = false;
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
      this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    addEventListener(name, callback) { this.events[name] = callback; }
    remove() { this.removed = true; }
    closest() { return null; }
    getBoundingClientRect() { return { left: 20, top: 30 }; }
  }
  const toggle = new Element(), body = new Element(), plain = new Element();
  const document = { hidden: false, documentElement: { dataset: {} }, body,
    querySelector: () => toggle, querySelectorAll: () => [], createElement: () => new Element(),
    addEventListener: (name, callback) => events.set(name, callback) };
  const media = [reduce, fine].map(matches => ({ matches, addEventListener(_, callback) { this.change = callback; } }));
  const storage = new Map([['fuyelist-motion', saved]]);
  const context = vm.createContext({ document,
    window: { addEventListener: (name, callback) => windowEvents.set(name, callback) },
    matchMedia: query => query.includes('reduced') ? media[0] : media[1],
    localStorage: { getItem: key => { if (storageFails) throw Error('blocked'); return storage.get(key); }, setItem: (key, value) => { if (storageFails) throw Error('blocked'); storage.set(key, value); } },
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: callback => { timers.set(++serial, callback); return serial; },
    clearTimeout: id => timers.delete(id),
    IntersectionObserver: class { disconnect() {} observe() {} }
  });
  vm.runInContext(motion, context);
  return { document, toggle, body, frames, timers, media, events, windowEvents, storage, Element,
    aura: () => body.children.findLast(el => !el.removed),
    move: (x, y, target = plain, extra = {}) => events.get('pointermove')({ clientX: x, clientY: y, target, pointerType: 'mouse', buttons: 0, ...extra }),
    frame: now => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); }
  };
}

test('all public pages share the theme, motion toggle and active navigation', () => {
  for (const file of ['dist/index.html', 'dist/sidehustle/index.html', 'dist/muse/index.html']) {
    const html = read(file);
    assert.match(html, /href="\/ui\/theme\.css/);
    assert.match(html, /src="\/ui\/motion\.js/);
    assert.match(html, /class="motion-toggle"/);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    assert.match(html, /class="site-nav"/);
  }
});

test('catalog and curated project counts remain intact', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(read('dist/data.js'), context);
  assert.equal(context.window.CASES.length, 447);
  assert.equal((read('dist/sidehustle/index.html').match(/class="project"/g) || []).length, 169);
});

test('existing social cards and Muse feedback survive the redesign', () => {
  for (const [page, image] of [['dist/index.html', '/og-card-home-v3.png'], ['dist/muse/index.html', '/muse/og-card-v3.png']]) {
    const html = read(page);
    assert.equal((html.match(/property="og:image"/g) || []).length, 1);
    assert.ok(html.includes('content="https://fuyelist.com' + image + '"'));
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.ok(fs.statSync(root + 'dist' + image).size > 0);
    assert.doesNotMatch(html, /^(<<<<<<<|=======|>>>>>>>)/m);
  }
  const muse = read('dist/muse/index.html');
  assert.match(muse, /id="feedback-modal"/);
  assert.match(muse, /class="fb-qr" src="data:image\/jpeg;base64,/);
  assert.match(muse, /class="ad-banner"/);
  assert.match(muse, /累计被领次数：/);
  assert.match(read('dist/ui/theme.css'), /\.muse-page \.ad-banner[^{}]*\{ grid-column: 1 \/ -1;/);
});

test('inline scripts still parse on every page', () => {
  for (const file of ['dist/index.html', 'dist/sidehustle/index.html', 'dist/muse/index.html']) {
    for (const [, code] of read(file).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(code);
  }
});

test('desktop creates two noninteractive aura layers, never a canvas trail', () => {
  const h = harness();
  assert.equal(h.document.documentElement.dataset.motion, 'on');
  assert.equal(h.aura().className, 'cursor-aura');
  assert.equal(h.aura().attrs['aria-hidden'], 'true');
  assert.equal(h.aura().children.length, 2);
  assert.equal(h.frames.size, 0);
});

test('pointer tracking eases two layers at different speeds and resets after idle', () => {
  const h = harness();
  h.move(100, 100);
  h.frame(16);
  h.move(300, 200);
  h.frame(32);
  const [echo, glow] = h.aura().children;
  assert.notEqual(glow.style.transform, echo.style.transform);
  assert.ok(h.aura().classList.contains('is-visible'));
  assert.ok(h.frames.size > 0);
  [...h.timers.values()].forEach(callback => callback());
  assert.equal(h.frames.size, 0);
  assert.equal(h.aura().classList.contains('is-visible'), false);
});

test('animation frames stop after the follower settles', () => {
  const h = harness();
  h.move(100, 100); h.frame(16); h.move(220, 250);
  for (let t = 32; t < 3000; t += 16) h.frame(t);
  assert.equal(h.frames.size, 0);
});

test('card highlight is cleared when leaving, editing, using keyboard or backgrounding', () => {
  const h = harness();
  const card = new h.Element();
  card.closest = selector => selector.startsWith('.case') ? card : null;
  h.move(70, 90, card);
  assert.equal(card.style['--cursor-x'], '50px');
  assert.ok('data-cursor-lit' in card.attrs);
  h.events.get('keydown')({ key: 'Tab' });
  assert.equal('data-cursor-lit' in card.attrs, false);
  assert.equal(h.aura().classList.contains('is-visible'), false);
  const input = new h.Element(); input.closest = () => input;
  h.move(20, 30, input);
  assert.equal(h.aura().classList.contains('is-visible'), false);
  h.move(100, 100);
  h.windowEvents.get('blur')();
  assert.equal(h.frames.size, 0);
});

test('touch pointers never activate the effect', () => {
  const h = harness(); h.move(40, 40, undefined, { pointerType: 'touch' });
  assert.equal(h.aura().classList.contains('is-visible'), false);
});

test('feedback dialogs suppress cursor effects', () => {
  const h = harness(); h.move(100, 100);
  const dialog = new h.Element();
  dialog.closest = selector => selector.includes('[role="dialog"]') ? dialog : null;
  h.move(100, 100, dialog);
  assert.equal(h.aura().classList.contains('is-visible'), false);
  assert.equal(h.frames.size, 0);
});

test('coarse pointers and reduced-motion settings do not create an aura', () => {
  assert.equal(harness({ fine: false }).aura(), undefined);
  const h = harness({ reduce: true });
  assert.equal(h.aura(), undefined);
  assert.equal(h.toggle.disabled, true);
  assert.equal(h.document.documentElement.dataset.motion, 'off');
});

test('the switch persists and cleans up effects; OS setting changes take priority', () => {
  const h = harness();
  h.toggle.events.click();
  assert.equal(h.storage.get('fuyelist-motion'), 'off');
  assert.equal(h.aura(), undefined);
  h.toggle.events.click();
  assert.ok(h.aura());
  h.media[0].matches = true; h.media[0].change();
  assert.equal(h.aura(), undefined);
  assert.equal(h.toggle.disabled, true);
  assert.equal(harness({ saved: 'off' }).document.documentElement.dataset.motion, 'off');
});

test('blocked localStorage does not prevent rendering or toggling', () => {
  const h = harness({ storageFails: true });
  assert.ok(h.aura()); h.toggle.events.click(); assert.equal(h.aura(), undefined);
});

test('large halo is click-through and reduced-motion CSS hides it', () => {
  const css = read('dist/ui/theme.css');
  assert.match(css, /\.cursor-aura \{[^}]*pointer-events: none/);
  assert.match(css, /\.cursor-aura-glow \{[^}]*width: 480px/);
  assert.match(css, /\.cursor-aura \{ display: none; \}/);
  assert.match(css, /\.muse-page \[data-reveal\] \{ opacity: 1/);
});
