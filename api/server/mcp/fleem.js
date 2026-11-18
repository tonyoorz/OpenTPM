const { startFleemServer } = require('@librechat/api/fleem');

startFleemServer().catch(() => {
  console.error('Fleem MCP could not start. Check the API build and Fleem server configuration.');
  process.exitCode = 1;
});
