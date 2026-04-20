'use strict';

// ── LaunchDarkly vendor badge ───────────────────────────────────────────────
(function injectVendorBadge() {
  const navInner = document.querySelector('.nav-inner');
  if (!navInner) return;
  const badge = document.createElement('div');
  badge.className = 'nav-vendor-badge';
  badge.style.cssText = 'background:#405BFF;border-color:#405BFF;';
  badge.innerHTML = '<img src="/img/LaunchDarkly_Logo_1.png" alt="LaunchDarkly" style="height:20px;width:auto;display:block;">';
  navInner.appendChild(badge);
}());
// ───────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize LaunchDarkly client SDK before applying flags
  await LDFlags.init();

  const navLinks = document.querySelector('.nav-links');

  // show-vacation-mode-ui: hide the Vacation Mode nav link if flag is off
  const showVacationMode = LDFlags.get('show-vacation-mode-ui');
  if (!showVacationMode && navLinks) {
    const vmLink = navLinks.querySelector('[href="/vacation-mode.html"]');
    if (vmLink) vmLink.closest('li').remove();
    const badge = document.getElementById('vacation-badge');
    if (badge) badge.style.display = 'none';
  }

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
    const banner = document.createElement('div');
    banner.id = 'promo-banner';
    banner.style.cssText = 'background:#405BFF;color:#fff;text-align:center;padding:.5rem 1rem;font-size:.875rem;font-weight:600;';
    banner.textContent = promoText;
    document.body.insertBefore(banner, document.body.firstChild);
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

  // Real-time flag updates
  LDFlags.onChange('show-vacation-mode-ui', (newValue) => {
    location.reload();
  });
  LDFlags.onChange('promo-banner-text', (newValue) => {
    const existing = document.getElementById('promo-banner');
    if (newValue) {
      if (existing) { existing.textContent = newValue; }
      else {
        const banner = document.createElement('div');
        banner.id = 'promo-banner';
        banner.style.cssText = 'background:#405BFF;color:#fff;text-align:center;padding:.5rem 1rem;font-size:.875rem;font-weight:600;';
        banner.textContent = newValue;
        document.body.insertBefore(banner, document.body.firstChild);
      }
    } else if (existing) {
      existing.remove();
    }
  });
});

function updateVacationBadge() {
  const badge = document.getElementById('vacation-badge');
  if (!badge) return;
  const on = localStorage.getItem('vacationModeEnabled') === 'true';
  badge.className = `nav-vacation-badge ${on ? 'on' : 'off'}`;
  badge.innerHTML = `<span class="vacation-dot"></span>${on ? 'Vacation Mode: ON' : 'Vacation Mode: OFF'}`;
}

window.updateVacationBadge = updateVacationBadge;
