const express = require('express');
const path = require('path');
const { getReservasResumo } = require('./src/hospedin');

const app = express();
const PORT = process.env.PORT || 4000;
const RECIFE_OFFSET_MS = -3 * 60 * 60 * 1000;
const MAX_DIAS_PERSONALIZADO = 93;

app.use(express.static(path.join(__dirname, 'public')));

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmt(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function recifeToday() {
  return new Date(Date.now() + RECIFE_OFFSET_MS);
}

function resolveRange(query) {
  const today = recifeToday();
  const { range, from, to } = query;

  if (range === 'hoje') {
    const d = fmt(today);
    return { from: d, to: d };
  }
  if (range === '7dias') {
    const start = new Date(today.getTime());
    start.setUTCDate(start.getUTCDate() - 6);
    return { from: fmt(start), to: fmt(today) };
  }
  if (range === 'mes') {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    return { from: fmt(start), to: fmt(today) };
  }
  if (range === 'custom') {
    if (!from || !to) {
      throw Object.assign(new Error('Informe from e to (YYYY-MM-DD) para range=custom'), { status: 400 });
    }
    return { from, to };
  }
  throw Object.assign(new Error('range invalido: use hoje, 7dias, mes ou custom'), { status: 400 });
}

app.get('/api/reservas', async (req, res) => {
  try {
    const { from, to } = resolveRange(req.query);
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
      return res.status(400).json({ error: 'Intervalo de datas invalido' });
    }
    const spanDays = (toDate - fromDate) / 86_400_000 + 1;
    if (spanDays > MAX_DIAS_PERSONALIZADO) {
      return res.status(400).json({ error: `Intervalo maximo de ${MAX_DIAS_PERSONALIZADO} dias` });
    }
    const resumo = await getReservasResumo(from, to);
    res.json(resumo);
  } catch (err) {
    console.error('Erro em /api/reservas:', err);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dash EcoLodge rodando em http://localhost:${PORT}`);
});
