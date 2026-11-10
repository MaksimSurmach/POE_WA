try {
  const response = await fetch('http://supervisor/addons/self/info', {
    headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error();
  const {
    data: { options },
  } = await response.json();
  if (
    typeof options.database_url !== 'string' ||
    !options.database_url ||
    !/^[a-fA-F0-9]{64}$/.test(options.session_key) ||
    typeof options.target_id !== 'string'
  )
    throw new Error();
  const databaseUrl = new URL(options.database_url);
  if (!options.target_id) {
    if (databaseUrl.searchParams.has('host')) throw new Error();
    if (databaseUrl.hostname.endsWith('.neon.tech'))
      databaseUrl.hostname = databaseUrl.hostname.replace(/-pooler\./, '.');
  }
  Object.assign(process.env, {
    APP_ENV: 'staging',
    DATABASE_SSL_MODE: 'require',
    DATABASE_URL: databaseUrl.toString(),
    DATABASE_POOL_MAX: '2',
    COLLECTOR_RETENTION_ENABLED: 'false',
    MARKET_COLLECTION_SOURCE: 'trade-compatible',
    POE_TRADE_SESSION_KEY: options.session_key,
    POE_TRADE_ACCESS: 'owner_permitted',
    POE_TRADE_USER_AGENT:
      'poe-worksmith/0.1.0 (contact: https://github.com/MaksimSurmach/POE_WA)',
  });
  if (options.target_id) {
    process.argv = [
      process.execPath,
      'collectTrade.js',
      'serve',
      options.target_id,
    ];
    await import('./dist/entrypoints/collectTrade.js');
  } else {
    if (options.trade_username && options.trade_password) {
      Object.assign(process.env, {
        POE_TRADE_USERNAME: options.trade_username,
        POE_TRADE_PASSWORD: options.trade_password,
        POE_TRADE_BROWSER_PROFILE_DIR: '/tmp/worksmith-trade-browser',
      });
    }
    await import('./dist/entrypoints/collector.js');
  }
} catch {
  console.error(JSON.stringify({ errorCode: 'TRADE_SUPERVISOR_CONFIG' }));
  process.exitCode = 1;
}
