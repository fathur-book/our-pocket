// Glass chrome style checks. Run in the browser against index.html:
//   load this file with a <script> tag, then `await __glassCheck()`.
// Returns the names of failed checks (empty = pass). Phone checks only run at <=560px.
window.__glassCheck = async (only) => {
  const failed = [];
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const phone = innerWidth <= 560;
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const $ = s => document.querySelector(s);
  const cs = (el, prop, pseudo) => { el = typeof el === 'string' ? $(el) : el; return el ? getComputedStyle(el, pseudo || null).getPropertyValue(prop).trim() : ''; };
  const token = n => getComputedStyle(root).getPropertyValue(n).trim();
  // Resolve a CSS value (e.g. var(--fill)) to the browser's computed colour string.
  const probe = document.createElement('div'); document.body.appendChild(probe);
  const resolve = v => { probe.style.color = ''; probe.style.color = v; return getComputedStyle(probe).color; };
  const px = v => parseFloat(v) || 0;
  const alpha = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const blurOf = (el, pseudo) => cs(el, 'backdrop-filter', pseudo) + ' ' + cs(el, '-webkit-backdrop-filter', pseudo);
  const check = (group, name, ok) => { if (only && !only.includes(group)) return; if (!ok) failed.push(group + ':' + name); };
  const rect = s => ($(s) || document.body).getBoundingClientRect();
  const overlap = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);

  // Task 1: base layer
  check(1, 'fontSystem', !/Jakarta/i.test(cs('body', 'font-family')));
  check(1, 'noGoogleFonts', !$('link[href*="fonts.googleapis"]'));
  check(1, 'bgToken', token('--bg').toLowerCase() === (dark ? '#000000' : '#f2f2f7'));
  check(1, 'tokensDefined', ['--fill', '--glass-bg', '--glass-blur', '--glass-edge', '--glass-shadow'].every(t => token(t)));
  check(1, 'washLayer', cs(document.body, 'position', '::before') === 'fixed');
  const noBlur = !CSS.supports('backdrop-filter', 'blur(1px)') && !CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
  if (noBlur || matchMedia('(prefers-reduced-transparency: reduce)').matches)
    check(1, 'fallbackOpaque', resolve('var(--glass-bg)') === resolve('var(--surface)'));

  // Task 2: header + desktop tabs
  const header = $('header');
  check(2, 'headerNoFilter', !/blur/.test(blurOf(header)));
  check(2, 'headerGlass', cs(header, 'position', '::before') === 'absolute' && /blur/.test(blurOf(header, '::before')));
  check(2, 'safePillCapsule', px(cs('.safe-pill', 'border-top-left-radius')) >= 999 && cs('.safe-pill', 'border-top-width') === '0px');
  if (!phone) {
    const act = $('nav.tabs button.active');
    check(2, 'desktopTabCapsule', !/inset 0px -2px/.test(cs(act, 'box-shadow')) && alpha(cs(act, 'background-color')) > 0);
  }

  // Task 3: phone tab bar + FAB
  check(3, 'fabNoGlow', !/rgba\(5, 150, 105/.test(cs('.fab', 'box-shadow')));
  if (phone) {
    const bar = rect('nav.tabs');
    check(3, 'tabBarFloating', bar.left >= 12 && innerWidth - bar.right >= 12 && innerHeight - bar.bottom >= 12 && px(cs('nav.tabs', 'border-top-left-radius')) >= 999);
    const y = scrollY; scrollTo(0, 2000); await frame();
    const b2 = rect('nav.tabs');
    check(3, 'tabBarFixedAfterScroll', innerHeight - b2.bottom >= 12 && innerHeight - b2.bottom <= 40);
    scrollTo(0, y); await frame();
    const fab = rect('#fabBtn');
    check(3, 'fabClearsBar', fab.bottom <= bar.top - 8);
    if (innerWidth <= 320) check(3, 'noHScroll320', root.scrollWidth <= innerWidth);
  }

  // Task 4: modals + toast (opens a tall test sheet and a long toast, then cleans up)
  if (!only || only.includes(4)) {
    modalShell('Cek', '<div style="height:2000px"></div>'); await frame();
    const back = $('.modal-back'), modal = $('.modal'), head = $('.modal-head');
    if (back && modal) {
      check(4, 'backdropLight', alpha(cs(back, 'background-color')) <= 0.4 && /blur\(8px\)/.test(blurOf(back)));
      check(4, 'sheetRadius', cs(modal, 'border-top-left-radius') === '28px');
      check(4, 'headNoStrip', cs(head, 'border-bottom-width') === '0px' && alpha(cs(head, 'background-color')) === 0);
      const cr = cs('.modal-close', 'border-top-left-radius');
      check(4, 'closeRound', cr === '50%' || px(cr) >= 20);
      if (phone) check(4, 'grabHandle', cs(head, 'width', '::before') === '36px' && cs(head, 'height', '::before') === '5px');
      check(4, 'modalScrolls', cs(modal, 'overflow-y') === 'auto' && px(cs(modal, 'max-height')) > 0);
    } else check(4, 'modalOpened', false);
    if (typeof closeModal === 'function') closeModal();
    toast('Data diperbarui dari perangkat lain. '.repeat(4)); await frame();
    check(4, 'toastGlass', /blur/.test(blurOf('#toast')) && cs('#toast', 'color') === resolve('var(--text)'));
    if (phone) check(4, 'toastClearsBar', !overlap(rect('#toast'), rect('nav.tabs')));
    $('#toast').classList.add('hidden');
  }

  // Task 5: buttons, segmented controls, motion
  const tmp = document.createElement('div');
  tmp.innerHTML = '<button class="btn">a</button><button class="btn btn-dark">b</button><div class="seg"><button class="active">x</button><button>y</button></div><div class="type-grid"><button class="active">x</button></div>';
  document.body.appendChild(tmp);
  const [btn, btnDark] = tmp.querySelectorAll('.btn');
  check(5, 'btnFill', cs(btn, 'border-top-width') === '0px' && cs(btn, 'background-color') === resolve('var(--fill)'));
  check(5, 'btnDarkInverts', cs(btnDark, 'background-color') === resolve('var(--text)') && cs(btnDark, 'color') === resolve('var(--bg)'));
  const seg = tmp.querySelector('.seg');
  check(5, 'segTrack', cs(seg, 'background-color') === resolve('var(--fill)') && cs(seg, 'border-top-width') === '0px' && cs(seg.firstChild, 'background-color') === resolve('var(--surface)'));
  check(5, 'typeGridMatches', cs(tmp.querySelector('.type-grid button'), 'background-color') === resolve('var(--surface)'));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dur = Math.max(...cs(btn, 'transition-duration').split(',').map(px));
  check(5, 'reducedMotion', reduced ? dur === 0 : dur >= 0.18);
  tmp.remove(); probe.remove();
  return failed;
};
