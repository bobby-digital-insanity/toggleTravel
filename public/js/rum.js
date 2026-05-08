'use strict';

window.DD_RUM && window.DD_RUM.init({
  applicationId: '59a43bd1-7fc2-45a0-a2d3-f51d3387f744',
  clientToken: 'pub6b00cb73836e87a084a0f4648b8fb626',
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
