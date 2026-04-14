'use strict';

let vacationModeOn = localStorage.getItem('vacationModeEnabled') === 'true';

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('vm-toggle');
  const statusText = document.getElementById('vm-status-text');
  const prefsSection = document.getElementById('vm-prefs');
  const responseSection = document.getElementById('vm-response');
  const loadingSection = document.getElementById('vm-loading');

  // Style chips
  document.querySelectorAll('.style-chip').forEach((chip) => {
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
  });

  // Reflect saved state
  if (toggle) {
    toggle.checked = vacationModeOn;
    updateUI(vacationModeOn, false);
  }

  if (toggle) {
    toggle.addEventListener('change', async () => {
      const enabled = toggle.checked;
      await handleToggle(enabled);
    });
  }

  async function handleToggle(enabled) {
    if (statusText) {
      statusText.textContent = 'Thinking…';
      statusText.className = 'vm-status-text';
    }

    // Show loading
    if (prefsSection) prefsSection.style.display = 'none';
    if (responseSection) { responseSection.style.display = 'none'; responseSection.classList.remove('visible'); }
    if (loadingSection) loadingSection.style.display = 'block';

    const preferences = gatherPreferences();
    const bookingHistory = getBookingHistory();

    try {
      const result = await api.post('/api/vacation-mode', { enabled, preferences, bookingHistory });
      vacationModeOn = enabled;
      localStorage.setItem('vacationModeEnabled', enabled);
      if (window.updateVacationBadge) updateVacationBadge();

      if (loadingSection) loadingSection.style.display = 'none';
      updateUI(enabled, true, result);
    } catch (err) {
      if (loadingSection) loadingSection.style.display = 'none';
      if (prefsSection) prefsSection.style.display = '';
      showError(err.message);
      // Revert toggle
      const toggle = document.getElementById('vm-toggle');
      if (toggle) toggle.checked = !enabled;
    }
  }

  function updateUI(enabled, animate, result) {
    if (statusText) {
      statusText.textContent = enabled ? 'ON' : 'OFF';
      statusText.className = `vm-status-text ${enabled ? 'on' : ''}`;
    }

    if (!result) {
      if (prefsSection) prefsSection.style.display = enabled ? 'none' : '';
      return;
    }

    if (enabled && result) {
      renderOnState(result, animate);
    } else if (!enabled && result) {
      renderOffState(result, animate);
    }
  }

  function renderOnState(result, animate) {
    if (responseSection) {
      responseSection.classList.add('visible');
      responseSection.style.display = '';
    }

    // Welcome card
    const welcomeText = document.getElementById('vm-welcome-text');
    const personaEl = document.getElementById('vm-persona');
    const vibeEl = document.getElementById('vm-vibe');
    const farewellSection = document.getElementById('vm-farewell');
    if (farewellSection) farewellSection.style.display = 'none';

    const welcomeCard = document.getElementById('vm-welcome-card');
    if (welcomeCard) welcomeCard.style.display = '';

    if (personaEl && result.travelPersona) {
      personaEl.innerHTML = `✈ ${result.travelPersona}`;
    }

    if (welcomeText && result.welcomeMessage) {
      if (animate) {
        typeText(welcomeText, result.welcomeMessage);
      } else {
        welcomeText.textContent = result.welcomeMessage;
      }
    }

    if (vibeEl && result.vacationVibe) {
      vibeEl.textContent = `"${result.vacationVibe}"`;
    }

    // Recommended destinations
    if (result.recommendedDestinationIds && result.recommendedDestinationIds.length > 0) {
      loadRecommendedDestinations(result.recommendedDestinationIds);
    }
  }

  function renderOffState(result, animate) {
    const welcomeCard = document.getElementById('vm-welcome-card');
    const recsSection = document.getElementById('vm-recs-section');
    const farewellSection = document.getElementById('vm-farewell');

    if (welcomeCard) welcomeCard.style.display = 'none';
    if (recsSection) recsSection.style.display = 'none';

    if (farewellSection) {
      farewellSection.style.display = '';
      const farewellText = document.getElementById('vm-farewell-text');
      if (farewellText && result.farewellMessage) {
        if (animate) {
          typeText(farewellText, result.farewellMessage);
        } else {
          farewellText.textContent = result.farewellMessage;
        }
      }
      if (responseSection) { responseSection.classList.add('visible'); responseSection.style.display = ''; }
    }

    if (prefsSection) prefsSection.style.display = '';
  }
});

async function loadRecommendedDestinations(ids) {
  const container = document.getElementById('vm-recs-grid');
  const recsSection = document.getElementById('vm-recs-section');
  if (!container || !recsSection) return;

  recsSection.style.display = '';
  container.innerHTML = '<div class="loading-overlay"><div class="spinner"></div> Loading recommendations…</div>';

  try {
    const data = await api.get('/api/destinations');
    const recs = ids
      .map((id) => data.destinations.find((d) => d.id === id))
      .filter(Boolean);

    if (recs.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = recs.map(destCard).join('');
  } catch (err) {
    container.innerHTML = '';
  }
}

function destCard(d) {
  return `
    <a href="/destination.html?id=${d.id}" class="card" style="text-decoration:none;color:inherit">
      <img src="${d.heroImage}" alt="${d.name}" class="card-img" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1488085061387-422e29b40080?w=600&q=70'">
      <div class="card-body">
        <div class="card-region">${d.region}</div>
        <div class="card-title">${d.name}</div>
        <div class="card-tagline">${d.tagline}</div>
        <div class="card-footer">
          <div class="card-price">$${d.basePrice.toLocaleString()} <span>/ person</span></div>
          <div class="card-rating">⭐ ${d.rating}</div>
        </div>
      </div>
    </a>`;
}

function typeText(el, text, speed = 18) {
  el.textContent = '';
  el.classList.add('typing-cursor');
  let i = 0;
  const timer = setInterval(() => {
    el.textContent += text[i];
    i++;
    if (i >= text.length) {
      clearInterval(timer);
      el.classList.remove('typing-cursor');
    }
  }, speed);
}

function gatherPreferences() {
  const budget = document.getElementById('pref-budget')?.value;
  const duration = document.getElementById('pref-duration')?.value;
  const selectedStyles = [...document.querySelectorAll('.style-chip.selected')].map((c) => c.dataset.value);
  return {
    budget: budget || 'flexible',
    duration: duration || 'flexible',
    style: selectedStyles.join(', ') || 'any',
  };
}

function getBookingHistory() {
  try {
    return JSON.parse(localStorage.getItem('bookingHistory') || '[]');
  } catch { return []; }
}

function showError(message) {
  const existing = document.getElementById('vm-error');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'vm-error';
  div.className = 'alert alert-error';
  div.style.maxWidth = '600px';
  div.style.margin = '0 auto 24px';
  div.innerHTML = `⚠ ${message}`;
  const prefs = document.getElementById('vm-prefs');
  if (prefs) prefs.prepend(div);
}
