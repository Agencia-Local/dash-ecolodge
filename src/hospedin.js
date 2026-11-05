const BASE_URL = 'https://pms.hospedin.com';
const STATUSES_CONTADOS = 'pre_reservation,reservation,waitlist,check_in,cleaning,check_out,no_show';
const LEAD_SOURCE_REGEX = /Como conheceu[^?]*\?:\s*([^\n]+)/i;

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }
  const res = await fetch(`${BASE_URL}/api/v3/authentication/access_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.HOSPEDIN_CLIENT_ID,
      client_secret: process.env.HOSPEDIN_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Falha na autenticacao Hospedin (${res.status})`);
  }
  const body = await res.json();
  cachedToken = body.meta.access_token;
  cachedTokenExpiresAt = now + body.meta.expires_in * 1000;
  return cachedToken;
}

async function fetchAllPages(path, params) {
  const token = await getToken();
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  let items = [];
  let next = url.toString();
  while (next) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(`Hospedin ${path} -> ${res.status}: ${body?.errors?.[0]?.detail ?? res.statusText}`);
    }
    const body = await res.json();
    items = items.concat(body.data);
    next = body.links?.next ? new URL(body.links.next, BASE_URL).toString() : null;
  }
  return items;
}

async function bookingsCreatedOnDay(dateStr) {
  return fetchAllPages('/api/v3/bookings', {
    'page[size]': '100',
    'filter[created_at][gte]': `${dateStr}T00:00:00-03:00`,
    'filter[created_at][lte]': `${dateStr}T23:59:59-03:00`,
    'filter[status]': STATUSES_CONTADOS,
  });
}

async function listSaleChannels() {
  const data = await fetchAllPages('/api/v3/channels', { 'page[size]': '100' });
  return new Map(data.map((c) => [c.id, c.attributes.name]));
}

function extractLeadSources(note) {
  if (!note) return [];
  const match = note.match(LEAD_SOURCE_REGEX);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function* eachDay(fromStr, toStr) {
  let cur = new Date(`${fromStr}T00:00:00Z`);
  const end = new Date(`${toStr}T00:00:00Z`);
  while (cur <= end) {
    yield cur.toISOString().slice(0, 10);
    cur = new Date(cur.getTime() + 86_400_000);
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const current = next++;
      results[current] = await fn(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function getReservasResumo(fromStr, toStr) {
  const days = [...eachDay(fromStr, toStr)];
  const [channelNameById, perDayBookings] = await Promise.all([
    listSaleChannels(),
    mapWithConcurrency(days, 5, bookingsCreatedOnDay),
  ]);

  const porDia = [];
  const porCanalMap = new Map();
  const porOrigemMap = new Map();
  let total = 0;
  let origemInformada = 0;

  days.forEach((day, i) => {
    const bookings = perDayBookings[i];
    porDia.push({ date: day, total: bookings.length });
    total += bookings.length;

    for (const booking of bookings) {
      const channelId = booking.attributes.sale_channel_id;
      const channelName = channelId != null ? (channelNameById.get(String(channelId)) ?? 'Outro') : 'Direto';
      porCanalMap.set(channelName, (porCanalMap.get(channelName) ?? 0) + 1);

      const origens = extractLeadSources(booking.attributes.note);
      if (origens.length) {
        origemInformada += 1;
        for (const origem of origens) {
          porOrigemMap.set(origem, (porOrigemMap.get(origem) ?? 0) + 1);
        }
      }
    }
  });

  const toSortedList = (map) =>
    [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return {
    from: fromStr,
    to: toStr,
    total,
    porDia,
    porCanal: toSortedList(porCanalMap),
    porOrigem: toSortedList(porOrigemMap),
    origemInformada,
  };
}

module.exports = { getReservasResumo };
