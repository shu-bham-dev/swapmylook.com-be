import brevo from '@getbrevo/brevo';

console.log('Brevo module:', brevo);
console.log('Type of brevo:', typeof brevo);
console.log('Keys:', Object.keys(brevo).filter(k => !k.startsWith('_')));
console.log('Has ApiClient?', 'ApiClient' in brevo);
console.log('ApiClient:', brevo.ApiClient);
console.log('ApiClient.instance:', brevo.ApiClient?.instance);

// Also check default export
console.log('\nChecking default export properties...');
for (const key in brevo) {
  if (brevo[key] && typeof brevo[key] === 'object') {
    console.log(`${key}:`, Object.keys(brevo[key] || {}).slice(0, 5));
  }
}