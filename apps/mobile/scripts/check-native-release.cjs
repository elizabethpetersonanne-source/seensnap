const config = require('../app.json').expo;

function checkRelease(env) {
  const failures = [];
  if (!env.SEENSNAP_EXPO_OWNER?.trim()) failures.push('Set SEENSNAP_EXPO_OWNER to the confirmed Expo account/organization.');
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(env.SEENSNAP_EAS_PROJECT_ID || '')) failures.push('Link the SeenSnap Expo project and set SEENSNAP_EAS_PROJECT_ID.');
  try {
    const api = new URL(env.EXPO_PUBLIC_API_BASE_URL);
    if (api.protocol !== 'https:' || !api.pathname.endsWith('/api/v1') || ['localhost', '127.0.0.1'].includes(api.hostname)) throw new Error();
  } catch { failures.push('Set an HTTPS EXPO_PUBLIC_API_BASE_URL ending in /api/v1.'); }
  if (env.EXPO_PUBLIC_ENABLE_DEV_AUTH === 'true') failures.push('Test sign-in must be disabled in release builds.');
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || "")) failures.push('Set EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID so existing Google users can sign in. Use an iOS OAuth client, not a web client.');
  if (config.ios.bundleIdentifier !== 'com.seensnap.app') failures.push('Bundle ID must match the registered Apple app.');
  return failures;
}

if (require.main === module && (process.env.SEENSNAP_RELEASE_BUILD === 'true' || process.argv.includes('--release'))) {
  const failures = checkRelease(process.env);
  if (failures.length) {
    console.error('Native release configuration is incomplete:\n' + failures.map(x => `- ${x}`).join('\n'));
    process.exitCode = 1;
  } else console.log('Native release configuration passed. Signing, provider credentials and device acceptance still need verification.');
}
module.exports = { checkRelease };
