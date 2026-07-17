'use strict';

const TT_USER_TIERS = [
  { key: 'beta',     name: 'Beta User',     email: 'beta@toggletravel.io',     color: '#8b5cf6' },
  { key: 'admin',    name: 'Admin User',    email: 'admin@toggletravel.io',    color: '#ef4444' },
  { key: 'silver',   name: 'Silver User',   email: 'silver@toggletravel.io',   color: '#94a3b8' },
  { key: 'gold',     name: 'Gold User',     email: 'gold@toggletravel.io',     color: '#f59e0b' },
  { key: 'platinum', name: 'Platinum User', email: 'platinum@toggletravel.io', color: '#38bdf8' },
  { key: 'diamond',  name: 'Diamond User',  email: 'diamond@toggletravel.io',  color: '#06b6d4' },
];

const TT_USER_STORAGE_KEY = 'tt-user-tier';

function getCurrentUser() {
  const tierKey = localStorage.getItem(TT_USER_STORAGE_KEY);
  if (!tierKey) return null;
  return TT_USER_TIERS.find((t) => t.key === tierKey) || null;
}

function setCurrentUser(tierKey) {
  const tier = TT_USER_TIERS.find((t) => t.key === tierKey);
  if (!tier) return;
  localStorage.setItem(TT_USER_STORAGE_KEY, tierKey);
  localStorage.setItem('tt-user-email', tier.email);
  localStorage.setItem('tt-user-name', tier.name);
  renderUserSelect();
  window.dispatchEvent(new CustomEvent('tt:user-changed', { detail: getCurrentUser() }));
}

function signOutUser() {
  localStorage.removeItem(TT_USER_STORAGE_KEY);
  localStorage.removeItem('tt-user-email');
  localStorage.removeItem('tt-user-name');
  renderUserSelect();
  window.dispatchEvent(new CustomEvent('tt:user-changed', { detail: null }));
}

function renderUserSelect() {
  const container = document.getElementById('user-select');
  if (!container) return;
  const user = getCurrentUser();

  if (!user) {
    container.innerHTML = `
      <button class="nav-user-btn nav-user-btn--signin" type="button" aria-haspopup="menu" aria-expanded="false">
        Sign in
      </button>
    `;
  } else {
    container.innerHTML = `
      <button class="nav-user-btn nav-user-btn--signedin" type="button" aria-haspopup="menu" aria-expanded="false" style="--tier-color:${user.color}">
        <span class="tier-dot" style="background:${user.color}"></span>
        <span class="nav-user-label">${user.name}</span>
        <span class="nav-user-caret">▾</span>
      </button>
    `;
  }

  const btn = container.querySelector('.nav-user-btn');
  btn.addEventListener('click', toggleUserMenu);
}

function toggleUserMenu(e) {
  e.stopPropagation();
  const container = document.getElementById('user-select');
  const existing = container.querySelector('.nav-user-menu');
  if (existing) {
    closeUserMenu();
    return;
  }

  const current = getCurrentUser();
  const menu = document.createElement('div');
  menu.className = 'nav-user-menu';
  menu.setAttribute('role', 'menu');

  const header = document.createElement('div');
  header.className = 'nav-user-menu-header';
  header.textContent = 'Select user';
  menu.appendChild(header);

  TT_USER_TIERS.forEach((tier) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'nav-user-option';
    if (current && current.key === tier.key) option.classList.add('nav-user-option--active');
    option.setAttribute('role', 'menuitem');
    option.innerHTML = `
      <span class="tier-dot" style="background:${tier.color}"></span>
      <span class="nav-user-option-name">${tier.name}</span>
      <span class="nav-user-option-tier">${tier.key.toUpperCase()}</span>
    `;
    option.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setCurrentUser(tier.key);
      closeUserMenu();
    });
    menu.appendChild(option);
  });

  if (current) {
    const divider = document.createElement('div');
    divider.className = 'nav-user-menu-divider';
    menu.appendChild(divider);

    const signOutBtn = document.createElement('button');
    signOutBtn.type = 'button';
    signOutBtn.className = 'nav-user-option nav-user-option--signout';
    signOutBtn.setAttribute('role', 'menuitem');
    signOutBtn.textContent = 'Sign out';
    signOutBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      signOutUser();
      closeUserMenu();
    });
    menu.appendChild(signOutBtn);
  }

  container.appendChild(menu);
  container.querySelector('.nav-user-btn').setAttribute('aria-expanded', 'true');

  document.addEventListener('click', onDocClickCloseMenu);
  document.addEventListener('keydown', onEscCloseMenu);
}

function closeUserMenu() {
  const container = document.getElementById('user-select');
  if (!container) return;
  const menu = container.querySelector('.nav-user-menu');
  if (menu) menu.remove();
  const btn = container.querySelector('.nav-user-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onDocClickCloseMenu);
  document.removeEventListener('keydown', onEscCloseMenu);
}

function onDocClickCloseMenu(e) {
  const container = document.getElementById('user-select');
  if (container && !container.contains(e.target)) closeUserMenu();
}

function onEscCloseMenu(e) {
  if (e.key === 'Escape') closeUserMenu();
}

function injectHamburger() {
  const navInner = document.querySelector('.nav-inner');
  const navLinks = document.querySelector('.nav-links');
  if (!navInner || !navLinks || document.getElementById('nav-hamburger')) return;

  // Build hamburger button
  const btn = document.createElement('button');
  btn.id = 'nav-hamburger';
  btn.className = 'nav-hamburger';
  btn.setAttribute('aria-label', 'Open menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span></span><span></span><span></span>';
  navInner.appendChild(btn);

  // Build mobile overlay + drawer with the same links as the desktop nav
  const overlay = document.createElement('div');
  overlay.id = 'nav-mobile-menu';
  overlay.className = 'nav-mobile-menu';

  const drawer = document.createElement('nav');
  drawer.className = 'nav-mobile-drawer';

  const links = [
    { href: '/',             label: 'Home' },
    { href: '/search.html',  label: 'Destinations' },
    { href: '/bookings.html',label: 'My Trips' },
    { href: '/ai-planner',   label: 'AI Planner' },
    { href: '/about.html',   label: 'About' },
  ];

  links.forEach((link) => {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    if (location.pathname === new URL(link.href, location.origin).pathname ||
        (link.href !== '/' && location.pathname.startsWith(new URL(link.href, location.origin).pathname))) {
      a.classList.add('active');
    }
    drawer.appendChild(a);
  });

  overlay.appendChild(drawer);
  document.body.appendChild(overlay);

  function openMenu() {
    btn.classList.add('is-open');
    overlay.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onEscClose);
  }

  function closeMenu() {
    btn.classList.remove('is-open');
    overlay.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onEscClose);
  }

  function onEscClose(e) { if (e.key === 'Escape') closeMenu(); }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    btn.classList.contains('is-open') ? closeMenu() : openMenu();
  });

  // Tap on the dark backdrop (outside drawer) closes the menu
  overlay.addEventListener('click', (e) => {
    if (!drawer.contains(e.target)) closeMenu();
  });

  // Navigating to a link closes the menu
  drawer.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMenu));
}

function injectUserSelect() {
  const navInner = document.querySelector('.nav-inner');
  if (!navInner) return;
  if (document.getElementById('user-select')) return;
  const container = document.createElement('div');
  container.id = 'user-select';
  container.className = 'nav-user-select';
  navInner.appendChild(container);
  renderUserSelect();
}

// ── Synchronous nav hydration ───────────────────────────────────────────────
// Runs at script parse, before first paint, so the nav lands in its final
// layout immediately. Avoids the visible reflow when the user-select pops in
// later after LD init.
(function injectVendorBadge() {
  const navInner = document.querySelector('.nav-inner');
  if (!navInner) return;
  const badge = document.createElement('div');
  badge.className = 'nav-vendor-badge';
  badge.style.cssText = 'background:#405BFF;border-color:#405BFF;';
  badge.innerHTML = '<img src="/img/LaunchDarkly_Logo_1.png" alt="LaunchDarkly" style="height:20px;width:auto;display:block;">';
  navInner.appendChild(badge);
}());

injectUserSelect();
injectHamburger();

// Active nav link — pure location/DOM, no LD dependency
(function highlightActiveLink() {
  document.querySelectorAll('.nav-links a').forEach((link) => {
    if (link.href === location.href || location.pathname.startsWith(new URL(link.href).pathname) && new URL(link.href).pathname !== '/') {
      link.classList.add('active');
    }
    if (link.href === location.origin + '/' && location.pathname === '/') {
      link.classList.add('active');
    }
  });
}());

// LDFlags.identify internally awaits its own ready promise, so it's safe to
// wire this before LD has initialized.
window.addEventListener('tt:user-changed', async (e) => {
  const user = e.detail;
  if (user) {
    await LDFlags.identify(user.email, { tier: user.key });
  } else {
    const anonKey = localStorage.getItem('tt-session-id');
    if (anonKey) await LDFlags.identify(anonKey);
  }
});
// ───────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await LDFlags.init();

  const navLinks = document.querySelector('.nav-links');

  // show-demo-panel: inject Load Gen nav link only if flag is on
  const showDemoPanel = LDFlags.get('show-demo-panel');
  if (showDemoPanel && navLinks && !navLinks.querySelector('[href="/demo.html"]')) {
    const li = document.createElement('li');
    li.innerHTML = '<a href="/demo.html">Load Gen</a>';
    navLinks.appendChild(li);
  }

  // promo-banner-text: show a banner across the top if flag has a value
  const promoText = LDFlags.get('promo-banner-text');
  if (promoText) {
    document.body.insertBefore(buildPromoBanner(promoText), document.body.firstChild);
  }

  // Real-time flag updates
  LDFlags.onChange('promo-banner-text', (newValue) => {
    const existing = document.getElementById('promo-banner');
    if (newValue) {
      if (existing) {
        existing.replaceWith(buildPromoBanner(newValue));
      } else {
        document.body.insertBefore(buildPromoBanner(newValue), document.body.firstChild);
      }
    } else if (existing) {
      existing.remove();
    }
  });
});

window.ToggleUser = {
  TIERS: TT_USER_TIERS,
  getCurrentUser,
  setUser: setCurrentUser,
  signOut: signOutUser,
};

function buildPromoBanner(text) {
  const banner = document.createElement('div');
  banner.id = 'promo-banner';
  banner.style.cssText = 'background:#405BFF;color:#fff;text-align:center;padding:.5rem 1rem;font-size:.875rem;font-weight:600;display:flex;align-items:center;justify-content:center;gap:16px;';
  const span = document.createElement('span');
  span.textContent = text;
  const btn = document.createElement('a');
  btn.href = '/search.html';
  btn.textContent = 'Search Flights →';
  btn.style.cssText = 'background:#fff;color:#405BFF;padding:.25rem .75rem;border-radius:999px;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;';
  // promo-click: secondary metric for the promo-banner experiment. Fires against
  // the same context that evaluated promo-banner-text, so it's attributable per arm.
  btn.addEventListener('click', () => {
    try { window.LDFlags?.track('promo-click', { promo: text }); } catch (_) { /* never block nav */ }
  });
  banner.appendChild(span);
  banner.appendChild(btn);
  return banner;
}
