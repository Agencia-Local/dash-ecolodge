const CAT_VARS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7'];
const MAX_BAR_SLOTS = 6;

const todayLabelEl = document.getElementById('todayLabel');
const totalEl = document.getElementById('totalReservas');
const periodoEl = document.getElementById('periodoLabel');
const chartEl = document.getElementById('lineChart');
const chartWrapEl = chartEl.closest('.chart-wrap');
const tooltipEl = document.getElementById('chartTooltip');
const tableEl = document.getElementById('dataTable');
const tableBodyEl = document.getElementById('dataTableBody');
const toggleTableBtn = document.getElementById('toggleTable');
const canalListEl = document.getElementById('canalList');
const origemListEl = document.getElementById('origemList');
const origemSubEl = document.getElementById('origemSub');
const customRangeEl = document.getElementById('customRange');
const fromInput = document.getElementById('fromInput');
const toInput = document.getElementById('toInput');
const applyCustomBtn = document.getElementById('applyCustom');

let currentRange = 'mes';

todayLabelEl.textContent = capitalize(
  new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
);

document.querySelectorAll('.pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    customRangeEl.hidden = currentRange !== 'custom';
    if (currentRange !== 'custom') {
      load({ range: currentRange });
    }
  });
});

applyCustomBtn.addEventListener('click', () => {
  if (!fromInput.value || !toInput.value) return;
  load({ range: 'custom', from: fromInput.value, to: toInput.value });
});

toggleTableBtn.addEventListener('click', () => {
  const showingTable = !tableEl.hidden;
  tableEl.hidden = showingTable;
  chartWrapEl.hidden = !showingTable;
  toggleTableBtn.textContent = showingTable ? 'Ver tabela' : 'Ver gráfico';
});

load({ range: currentRange });

async function load(params) {
  totalEl.textContent = '…';
  periodoEl.textContent = 'Carregando…';
  clearNode(canalListEl);
  clearNode(origemListEl);

  const query = new URLSearchParams(params).toString();
  let data;
  try {
    const res = await fetch(`/api/reservas?${query}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Erro ${res.status}`);
    }
    data = await res.json();
  } catch (err) {
    totalEl.textContent = '—';
    periodoEl.innerHTML = `<span class="load-error">Não consegui carregar: ${escapeHtml(err.message)}</span>`;
    return;
  }

  renderResumo(data);
}

function renderResumo(data) {
  totalEl.textContent = data.total;
  periodoEl.textContent = formatPeriodo(data.from, data.to);

  renderChart(data.porDia);
  renderTable(data.porDia);
  renderBarList(canalListEl, data.porCanal, 'Nenhuma reserva com canal registrado no período.');

  if (data.origemInformada === 0) {
    origemSubEl.textContent =
      'Nenhuma reserva do período respondeu essa pergunta no check-in — o bloco aparece vazio até haver dado.';
    renderBarList(origemListEl, [], 'Sem dados de origem no período.');
  } else {
    origemSubEl.textContent = `Extraído das observações da reserva — resposta disponível em ${data.origemInformada} de ${data.total} reserva(s).`;
    renderBarList(origemListEl, data.porOrigem, 'Sem dados de origem no período.');
  }
}

function formatPeriodo(from, to) {
  const fmt = (d) => new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' }).format(new Date(`${d}T12:00:00`));
  if (from === to) return `reservas feitas em ${fmt(from)}`;
  return `reservas feitas de ${fmt(from)} a ${fmt(to)}`;
}

function renderChart(porDia) {
  const PAD_L = 8;
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 24;
  const WIDTH = 700;
  const HEIGHT = 220;
  const plotW = WIDTH - PAD_L - PAD_R;
  const plotH = HEIGHT - PAD_T - PAD_B;

  const values = porDia.map((d) => d.total);
  const maxVal = Math.max(1, ...values);
  const n = porDia.length;

  const xAt = (i) => (n === 1 ? WIDTH / 2 : PAD_L + (i * plotW) / (n - 1));
  const yAt = (v) => PAD_T + plotH * (1 - v / maxVal);

  const linePoints = porDia.map((d, i) => `${xAt(i)},${yAt(d.total)}`).join(' ');
  const baselineY = yAt(0);

  const labelEvery = Math.max(1, Math.ceil(n / 7));

  let svg = '';
  svg += `<line x1="${PAD_L}" y1="${baselineY}" x2="${WIDTH - PAD_R}" y2="${baselineY}" stroke="var(--baseline)" stroke-width="1" />`;
  if (n > 1) {
    svg += `<polyline points="${linePoints}" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
  }

  porDia.forEach((d, i) => {
    const x = xAt(i);
    const y = yAt(d.total);
    svg += `<circle data-index="${i}" cx="${x}" cy="${y}" r="4" fill="var(--brand)" stroke="var(--surface-1)" stroke-width="2" style="cursor:pointer" />`;
    if (i % labelEvery === 0 || i === n - 1) {
      svg += `<text x="${x}" y="${HEIGHT - 6}" font-size="10" fill="var(--text-muted)" text-anchor="middle">${formatShortDate(d.date)}</text>`;
    }
  });

  chartEl.innerHTML = svg;

  chartEl.querySelectorAll('circle').forEach((circle) => {
    circle.addEventListener('mouseenter', (evt) => showTooltip(evt, porDia[Number(circle.dataset.index)]));
    circle.addEventListener('mousemove', (evt) => showTooltip(evt, porDia[Number(circle.dataset.index)]));
    circle.addEventListener('mouseleave', hideTooltip);
  });
}

function showTooltip(evt, point) {
  const wrapRect = chartWrapEl.getBoundingClientRect();
  const targetRect = evt.target.getBoundingClientRect();
  tooltipEl.hidden = false;
  tooltipEl.style.left = `${targetRect.left - wrapRect.left + targetRect.width / 2}px`;
  tooltipEl.style.top = `${targetRect.top - wrapRect.top - 8}px`;
  tooltipEl.textContent = `${formatShortDate(point.date)} · ${point.total} reserva(s)`;
}

function hideTooltip() {
  tooltipEl.hidden = true;
}

function renderTable(porDia) {
  tableBodyEl.innerHTML = porDia
    .map((d) => `<tr><td>${formatShortDate(d.date)}</td><td>${d.total}</td></tr>`)
    .join('');
}

function renderBarList(container, items, emptyMessage) {
  clearNode(container);

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }

  const top = items.slice(0, MAX_BAR_SLOTS);
  const rest = items.slice(MAX_BAR_SLOTS);
  const restTotal = rest.reduce((sum, item) => sum + item.count, 0);
  const rows = restTotal > 0 ? [...top, { name: 'Outras respostas', count: restTotal, isOther: true }] : top;

  const maxCount = Math.max(...rows.map((r) => r.count));

  rows.forEach((row, i) => {
    const pct = Math.max(6, Math.round((row.count / maxCount) * 100));
    const color = row.isOther ? 'var(--text-muted)' : `var(${CAT_VARS[i % CAT_VARS.length]})`;

    const rowEl = document.createElement('div');
    rowEl.className = 'bar-row';
    rowEl.innerHTML = `
      <span class="bar-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${color}"></span></span>
      <span class="bar-count">${row.count}</span>
    `;
    container.appendChild(rowEl);
  });
}

function formatShortDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(d);
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function clearNode(node) {
  node.innerHTML = '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
