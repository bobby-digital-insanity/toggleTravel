module.exports = {
  apps: [
    {
      name: 'toggle-travel',
      script: 'src/server.js',
      node_args: '--require ./src/instrumentation.js',
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
  ],
};
