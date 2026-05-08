'use strict';

window.DD_RUM && window.DD_RUM.init({
  applicationId: 'b47f898a-a574-4749-9060-2d95e75c51d9',
  clientToken: 'pub7b7c65bef50507f24cf4aa9a9aa384ee',
  site: 'us5.datadoghq.com',
  service: 'toggle-travel',
  env: 'production',
  sessionSampleRate: 100,
  sessionReplaySampleRate: 20,
  trackResources: true,
  trackUserInteractions: true,
  trackLongTasks: true,
  enableExperimentalFeatures: ['feature_flags'],
  allowedTracingUrls: [window.location.origin],
});
