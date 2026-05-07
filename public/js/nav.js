'use strict';

// ── Datadog vendor badge ────────────────────────────────────────────────────
(function injectVendorBadge() {
  const navInner = document.querySelector('.nav-inner');
  if (!navInner) return;
  const badge = document.createElement('div');
  badge.className = 'nav-vendor-badge';
  badge.style.cssText = 'background:rgba(99,44,166,.08);border-color:#632CA6;color:#632CA6;';
  badge.innerHTML = '<img src="/img/dd_icon_rgb.svg" alt="Datadog" style="height:22px;width:auto;display:block;"> Datadog';
  navInner.appendChild(badge);
}());
// ───────────────────────────────────────────────────────────────────────────

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
