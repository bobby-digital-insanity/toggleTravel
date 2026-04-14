'use strict';

// ── Dynatrace vendor badge ──────────────────────────────────────────────────
(function injectVendorBadge() {
  const navInner = document.querySelector('.nav-inner');
  if (!navInner) return;
  const badge = document.createElement('div');
  badge.className = 'nav-vendor-badge';
  badge.style.setProperty('--vendor-color', '#1496FF');
  badge.style.setProperty('--vendor-bg', 'rgba(20,150,255,.06)');
  badge.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4 4h12l16 28H20L4 4z" fill="#1496FF"/>
      <path d="M16 4h16L20 32H4L16 4z" fill="#1496FF" opacity=".45"/>
    </svg>
    Dynatrace`;
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
