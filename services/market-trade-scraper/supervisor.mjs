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
    typeof options.target_id !== 'string' ||
    !options.target_id
  )
    throw new Error();
  Object.assign(process.env, {
    APP_ENV: 'staging',
    DATABASE_SSL_MODE: 'require',
    DATABASE_URL: options.database_url,
    POE_TRADE_SESSION_KEY: options.session_key,
    POE_TRADE_ACCESS: 'owner_permitted',
    POE_TRADE_USER_AGENT:
      'poe-worksmith/0.1.0 (contact: https://github.com/MaksimSurmach/POE_WA)',
  });
  process.argv = [
    process.execPath,
    'collectTrade.js',
    'serve',
    options.target_id,
  ];
  await import('./dist/entrypoints/collectTrade.js');
} catch {
  console.error(JSON.stringify({ errorCode: 'TRADE_SUPERVISOR_CONFIG' }));
  process.exitCode = 1;
}
