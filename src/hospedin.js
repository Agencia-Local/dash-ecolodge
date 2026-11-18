const BASE_URL = 'https://pms.hospedin.com';
const IBGE_MUNICIPIOS_URL = 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios';
const STATUSES_CONTADOS = ['pre_reservation', 'reservation', 'waitlist', 'check_in', 'cleaning', 'check_out', 'no_show'];
const STATUS_CANCELADO = 'canceled';
const LEAD_SOURCE_REGEX = /Como conheceu[^?]*\?:\s*([^\n]+)/i;
const MUNICIPIO_UF_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cachedToken = null;
let cachedTokenExpiresAt = 0;

let cachedMunicipioUfMap = null;
let cachedMunicipioUfMapAt = 0;

function normalizeCityName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

async function getMunicipioUfMap() {
  const now = Date.now();
  if (cachedMunicipioUfMap && now < cachedMunicipioUfMapAt + MUNICIPIO_UF_CACHE_TTL_MS) {
    return cachedMunicipioUfMap;
  }
  const res = await fetch(IBGE_MUNICIPIOS_URL);
  if (!res.ok) {
    throw new Error(`IBGE municipios -> ${res.status}`);
  }
  const municipios = await res.json();
  const map = new Map();
  for (const m of municipios) {
    const uf = m?.microrregiao?.mesorregiao?.UF?.sigla;
    if (!uf || !m?.nome) continue;
    map.set(normalizeCityName(m.nome), uf);
  }
  cachedMunicipioUfMap = map;
  cachedMunicipioUfMapAt = now;
  return map;
}

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

async function bookingsOnDay(dateStr) {
  return fetchAllPages('/api/v3/bookings', {
    'page[size]': '100',
    'filter[created_at][gte]': `${dateStr}T00:00:00-03:00`,
    'filter[created_at][lte]': `${dateStr}T23:59:59-03:00`,
  });
}

async function listSaleChannels() {
  const data = await fetchAllPages('/api/v3/channels', { 'page[size]': '100' });
  return new Map(data.map((c) => [c.id, c.attributes.name]));
}

function bookingStatus(booking) {
  return booking.attributes.units?.[0]?.status ?? null;
}

function bookingNights(booking) {
  return (booking.attributes.units || []).reduce((sum, unit) => {
    const nights = (new Date(unit.check_out) - new Date(unit.check_in)) / 86_400_000;
    return sum + (Number.isFinite(nights) && nights > 0 ? nights : 0);
  }, 0);
}

function bookingDiariasCents(booking) {
  return (booking.attributes.units || []).reduce((sum, unit) => sum + (unit.total_daily_cents || 0), 0);
}

function cleanField(value) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed : null;
}

function guestLocation(guest) {
  const contact = guest?.attributes?.contact;
  return {
    city: cleanField(contact?.city),
    state: cleanField(contact?.state),
  };
}

async function listGuestLocations(guestIds) {
  const uniqueIds = [...new Set(guestIds.filter((id) => id != null))];
  const token = await getToken();
  const entries = await mapWithConcurrency(uniqueIds, 5, async (id) => {
    const res = await fetch(`${BASE_URL}/api/v3/guests/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [id, { city: null, state: null }];
    const body = await res.json();
    return [id, guestLocation(body.data)];
  });
  return new Map(entries);
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
    mapWithConcurrency(days, 5, bookingsOnDay),
  ]);

  const porDia = [];
  const porCanalMap = new Map();
  const porOrigemMap = new Map();
  const porRegiaoMap = new Map();
  const porEstadoMap = new Map();
  let total = 0;
  let totalCancelados = 0;
  let totalDiarias = 0;
  let totalDiariasCents = 0;
  let origemInformada = 0;
  let regiaoInformada = 0;
  let estadoInformada = 0;

  const activeByDay = [];

  days.forEach((day, i) => {
    const bookings = perDayBookings[i];
    let activeCount = 0;
    let canceladosCount = 0;
    const active = [];

    for (const booking of bookings) {
      const status = bookingStatus(booking);
      if (status === STATUS_CANCELADO) {
        canceladosCount += 1;
        continue;
      }
      if (!STATUSES_CONTADOS.includes(status)) continue;
      activeCount += 1;
      active.push(booking);
    }

    porDia.push({ date: day, total: activeCount, cancelados: canceladosCount });
    total += activeCount;
    totalCancelados += canceladosCount;
    activeByDay.push(active);
  });

  const allActive = activeByDay.flat();

  for (const booking of allActive) {
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

    totalDiarias += bookingNights(booking);
    totalDiariasCents += bookingDiariasCents(booking);
  }

  let municipioUfMap = null;
  try {
    municipioUfMap = await getMunicipioUfMap();
  } catch (err) {
    console.error('Falha ao carregar municipios do IBGE, usando so o campo estado bruto:', err);
  }

  const locationByGuestId = await listGuestLocations(allActive.map((b) => b.attributes.guest_id));
  for (const booking of allActive) {
    const location = locationByGuestId.get(booking.attributes.guest_id);
    if (location?.city) {
      regiaoInformada += 1;
      porRegiaoMap.set(location.city, (porRegiaoMap.get(location.city) ?? 0) + 1);
    }

    const estadoViaCidade = location?.city ? municipioUfMap?.get(normalizeCityName(location.city)) : null;
    const estado = estadoViaCidade ?? location?.state ?? null;
    if (estado) {
      estadoInformada += 1;
      porEstadoMap.set(estado, (porEstadoMap.get(estado) ?? 0) + 1);
    }
  }

  const toSortedList = (map) =>
    [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return {
    from: fromStr,
    to: toStr,
    total,
    totalCancelados,
    totalDiarias,
    totalDiariasReais: totalDiariasCents / 100,
    porDia,
    porCanal: toSortedList(porCanalMap),
    porOrigem: toSortedList(porOrigemMap),
    origemInformada,
    porRegiao: toSortedList(porRegiaoMap),
    regiaoInformada,
    porEstado: toSortedList(porEstadoMap),
    estadoInformada,
  };
}

module.exports = { getReservasResumo };
