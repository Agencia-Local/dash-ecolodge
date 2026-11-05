const BASE_URL = 'https://pms.hospedin.com';

async function getAccessToken() {
  const res = await fetch(`${BASE_URL}/api/v3/authentication/access_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.HOSPEDIN_CLIENT_ID,
      client_secret: process.env.HOSPEDIN_CLIENT_SECRET,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Falha na autenticacao (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.meta;
}

async function probe(token, path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let detail = '';
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    detail = body?.errors?.[0]?.detail ?? '';
  }
  return { path, status: res.status, ok: res.ok, detail };
}

async function main() {
  if (!process.env.HOSPEDIN_CLIENT_ID || !process.env.HOSPEDIN_CLIENT_SECRET) {
    console.error('Defina HOSPEDIN_CLIENT_ID e HOSPEDIN_CLIENT_SECRET no .env antes de rodar.');
    process.exit(1);
  }

  console.log('Autenticando...');
  const meta = await getAccessToken();
  console.log(`Token obtido (${meta.token_type}), expira em ${meta.expires_in}s (${meta.expires_at}).\n`);

  const endpoints = [
    '/api/v3/bookings?page[size]=1',
    '/api/v3/rooms?page[size]=1',
    '/api/v3/channels?page[size]=1',
    '/api/v3/companies?page[size]=1',
    '/api/v3/occupancy/today',
    '/api/v3/reports/revenue',
    '/api/v3/financial/transactions?page[size]=1',
  ];

  console.log('Testando acesso a endpoints de leitura:\n');
  for (const path of endpoints) {
    const result = await probe(meta.access_token, path);
    const label = result.ok ? 'OK' : `BLOQUEADO (${result.status})`;
    console.log(`${label.padEnd(18)} ${path}${result.detail ? ' - ' + result.detail : ''}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
