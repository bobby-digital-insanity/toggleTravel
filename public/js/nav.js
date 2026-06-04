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

document.addEventListener('DOMContentLoaded', () => {
  // Inject Load Gen nav link if not already in the HTML
  const navLinks = document.querySelector('.nav-links');
  if (navLinks && !navLinks.querySelector('[href="/demo.html"]')) {
    const li = document.createElement('li');
    li.innerHTML = '<a href="/demo.html">Load Gen</a>';
    navLinks.appendChild(li);
  }

  // Active nav link
  const links = document.querySelectorAll('.nav-links a');
  links.forEach((link) => {
    if (link.href === location.href || location.pathname.startsWith(new URL(link.href).pathname) && new URL(link.href).pathname !== '/') {
      link.classList.add('active');
    }
    if (link.href === location.origin + '/' && location.pathname === '/') {
      link.classList.add('active');
    }
  });

  // User select
  injectUserSelect();
});

window.ToggleUser = {
  TIERS: TT_USER_TIERS,
  getCurrentUser,
  setUser: setCurrentUser,
  signOut: signOutUser,
};
