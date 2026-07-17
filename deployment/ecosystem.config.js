module.exports = {
  apps: [
    {
      name: 'toggle-travel',
      script: 'src/server.js',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/toggle-travel/error.log',
      out_file: '/var/log/toggle-travel/out.log',
    },
    {
      // 24/7 traffic conductor — diurnal load gen + API traffic + daily
      // 7am ET guarded-rollout checkout incident (see scripts/traffic-conductor.js).
      name: 'toggle-traffic',
      script: 'scripts/traffic-conductor.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      env_development: {
        NODE_ENV: 'development',
        TRAFFIC_ENABLED: 'false',
      },
      env_production: {
        NODE_ENV: 'production',
        TRAFFIC_ENABLED: 'true',
        // TEMPORARY (validation of the browser checkout surge — REVERT after):
        // fire the guarded rollout 2 min after boot instead of waiting for 7am.
        INCIDENT_TEST_DELAY_MIN: '2',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/toggle-travel/traffic-error.log',
      out_file: '/var/log/toggle-travel/traffic-out.log',
    },
  ],
};
