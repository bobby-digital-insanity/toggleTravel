'use strict';

// ── LaunchDarkly vendor badge ───────────────────────────────────────────────
(function injectVendorBadge() {
  const navInner = document.querySelector('.nav-inner');
  if (!navInner) return;
  const badge = document.createElement('div');
  badge.className = 'nav-vendor-badge';
  badge.style.setProperty('--vendor-color', '#405BFF');
  badge.style.setProperty('--vendor-bg', 'rgba(64,91,255,.06)');
  badge.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="18" cy="18" r="16" fill="#405BFF"/>
      <path d="M12 12l12 6-12 6V12z" fill="white"/>
    </svg>
    LaunchDarkly`;
  navInner.appendChild(badge);
}());
// ───────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
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

  // Vacation mode badge
  updateVacationBadge();
});

function updateVacationBadge() {
  const badge = document.getElementById('vacation-badge');
  if (!badge) return;
  const on = localStorage.getItem('vacationModeEnabled') === 'true';
  badge.className = `nav-vacation-badge ${on ? 'on' : 'off'}`;
  badge.innerHTML = `<span class="vacation-dot"></span>${on ? 'Vacation Mode: ON' : 'Vacation Mode: OFF'}`;
}

window.updateVacationBadge = updateVacationBadge;
