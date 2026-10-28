// ================= Estado =================
// API de Python que lee el Nodo B por USB. Se puede cambiar con ?api=http://otra-ip:8000
const API = new URLSearchParams(location.search).get('api') || `${location.protocol}//${location.hostname}:8000`;
const MAX_PUNTOS = 600;        // puntos visibles en las gráficas (10 min a 1 paquete por segundo)

let historial = [];            // lecturas de la sesión actual (de la bitácora)
let receptor = null;           // estado que reporta la API (puerto, sesión, conteos)
let apiEnLinea = false;

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ================= Gráficas =================
const C = {
  x: '#ff7a8a', y: '#7be38f', z: '#6ea8ff', mag: '#e8f1fb',
  rumbo: '#c8f560', alabeo: '#ff9f6b', cabeceo: '#b388ff',
  rssi: '#5ce1ff', snr: '#c8f560',
  temp: '#ff9f6b', hum: '#6ea8ff', gas: '#d16bff', alt: '#5ce1ff', uv: '#ffd84a',
  texto: '#8a9bb2', borde: 'rgba(140, 200, 255, 0.08)',
};
Chart.defaults.color = C.texto;
Chart.defaults.borderColor = C.borde;
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.animation = false;
Chart.defaults.maintainAspectRatio = false;
Chart.defaults.elements.point.radius = 0;
Chart.defaults.elements.point.hitRadius = 6;
Chart.defaults.elements.line.borderWidth = 2;
Chart.defaults.elements.line.tension = 0.25;
Chart.defaults.interaction = { mode: 'index', intersect: false };
Chart.defaults.scales.category.ticks.maxRotation = 0;
Chart.defaults.scales.category.ticks.autoSkipPadding = 24;

const serie = (label, color, extra = {}) => ({ label, data: [], borderColor: color, backgroundColor: color, ...extra });
const ejeDer = (texto, extra = {}) => ({ position: 'right', grid: { display: false }, title: { display: true, text: texto }, ...extra });

const gOri = new Chart($('g-ori'), {
  type: 'line',
  data: { labels: [], datasets: [
    serie('Alabeo °', C.alabeo, { yAxisID: 'y' }),
    serie('Cabeceo °', C.cabeceo, { yAxisID: 'y' }),
    serie('Rumbo °', C.rumbo, { yAxisID: 'y2', borderDash: [4, 4] }),
  ] },
  options: { scales: { y: { title: { display: true, text: 'alabeo / cabeceo °' } }, y2: ejeDer('rumbo °', { min: 0, max: 360, ticks: { stepSize: 90 } }) } },
});
const gGiro = new Chart($('g-giro'), {
  type: 'line',
  data: { labels: [], datasets: [
    serie('ωx', C.x), serie('ωy', C.y), serie('ωz', C.z),
    serie('|ω|', C.mag, { borderDash: [4, 4], borderWidth: 1.5 }),
  ] },
  options: { scales: { y: { title: { display: true, text: '°/s' } } } },
});
const gAcel = new Chart($('g-acel'), {
  type: 'line',
  data: { labels: [], datasets: [
    serie('ax', C.x), serie('ay', C.y), serie('az', C.z),
    serie('|a|', C.mag, { borderDash: [4, 4], borderWidth: 1.5 }),
  ] },
  options: { scales: { y: { title: { display: true, text: 'm/s²' } } } },
});
const gEnlace = new Chart($('g-enlace'), {
  type: 'line',
  data: { labels: [], datasets: [
    serie('RSSI dBm', C.rssi, { yAxisID: 'y', fill: true, backgroundColor: 'rgba(92, 225, 255, 0.10)' }),
    serie('SNR dB', C.snr, { yAxisID: 'y2' }),
  ] },
  options: { scales: { y: { title: { display: true, text: 'dBm' } }, y2: ejeDer('dB') } },
});
const gAmb = new Chart($('g-amb'), {
  type: 'line',
  data: { labels: [], datasets: [
    serie('Temperatura °C', C.temp, { yAxisID: 'y', spanGaps: true }),
    serie('Humedad %', C.hum, { yAxisID: 'y2', spanGaps: true }),
  ] },
  options: { scales: { y: { title: { display: true, text: '°C' } }, y2: ejeDer('%', { min: 0, max: 100 }) } },
});
const gGas = new Chart($('g-gas'), {
  type: 'line',
  data: { labels: [], datasets: [
    serie('Gas MQ-2 mV', C.gas, { yAxisID: 'y', fill: true, backgroundColor: 'rgba(209, 107, 255, 0.10)', spanGaps: true }),
    serie('Altitud GPS m', C.alt, { yAxisID: 'y2', borderDash: [4, 4], spanGaps: true }),
  ] },
  options: { scales: { y: { min: 0, title: { display: true, text: 'mV' } }, y2: ejeDer('m') } },
});

const gUV = new Chart($('g-uv'), {
  type: 'line',
  data: { labels: [], datasets: [serie('Índice UV', C.uv, { fill: true, backgroundColor: 'rgba(255, 216, 74, 0.12)', spanGaps: true })] },
  options: { scales: { y: { min: 0, suggestedMax: 11, title: { display: true, text: 'índice UV' } } } },
});

// Categorías de la OMS para el índice UV
function categoriaUV(uv) {
  if (uv === null || uv === undefined) return '';
  return uv < 3 ? 'Bajo' : uv < 6 ? 'Moderado' : uv < 8 ? 'Alto' : uv < 11 ? 'Muy alto' : 'Extremo';
}

// ================= Telemetría del BNO055 =================
const horaCorta = (t) => new Date(t).toLocaleTimeString('es-MX', { hour12: false });
const fechaHora = (t) => new Date(t).toLocaleString('es-MX', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const PUNTOS_CARDINALES = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const cardinal = (g) => (g === null || g === undefined ? '' : PUNTOS_CARDINALES[Math.round(((g % 360) + 360) % 360 / 45) % 8]);
const calTexto = (p) => (p && p.cal_sys !== null && p.cal_sys !== undefined ? `${p.cal_sys}${p.cal_giro}${p.cal_acel}${p.cal_mag}` : '—');

// Estado del CanSat según su movimiento
function estadoMovimiento(p) {
  if (!p) return 'Sin telemetría';
  if (p.a_mag !== null && p.a_mag !== undefined && p.a_mag > 15) return 'Sacudida fuerte';
  if (p.w_mag < 3 && (p.a_mag ?? 0) < 0.5) return 'En reposo';
  if (p.w_mag < 30) return 'Balanceo';
  return 'Girando';
}

function pintarKPIs() {
  const p = historial[historial.length - 1];
  $('k-rumbo').textContent = fmt(p?.rumbo);
  $('k-rumbo-card').textContent = p?.rumbo !== null && p?.rumbo !== undefined ? `° · ${cardinal(p.rumbo)}` : '°';
  $('k-alabeo').textContent = fmt(p?.alabeo);
  $('k-cabeceo').textContent = fmt(p?.cabeceo);
  $('k-w').textContent = fmt(p?.w_mag);
  $('k-a').textContent = fmt(p?.a_mag, 2);
  $('k-rssi').textContent = fmt(p?.rssi, 0);
  $('k-snr').textContent = p?.snr !== null && p?.snr !== undefined ? `dBm · SNR ${fmt(p.snr)} dB` : 'dBm';
  const n = receptor?.lecturas ?? historial.length;
  const perd = receptor?.perdidos ?? 0;
  $('k-pkts').textContent = n;
  $('k-perdidos').textContent = n + perd > 0 ? `${perd} perdidos (${fmt((perd / (n + perd)) * 100, 1)} %)` : '';
  $('k-fase').textContent = estadoMovimiento(p);
  $('k-formato').textContent = p ? (p.formato === 'G' ? 'firmware antiguo: solo giroscopio' : `paquete #${p.seq}`) : '';
}

function redibujarTelemetria() {
  const v = historial.slice(-MAX_PUNTOS);
  const etiquetas = v.map((p) => horaCorta(p.t));
  const col = (k) => v.map((p) => p[k] ?? null);
  for (const g of [gOri, gGiro, gAcel, gEnlace, gAmb, gGas, gUV]) g.data.labels = etiquetas;
  [gOri.data.datasets[0].data, gOri.data.datasets[1].data, gOri.data.datasets[2].data] = [col('alabeo'), col('cabeceo'), col('rumbo')];
  [gGiro.data.datasets[0].data, gGiro.data.datasets[1].data, gGiro.data.datasets[2].data, gGiro.data.datasets[3].data] = [col('wx'), col('wy'), col('wz'), col('w_mag')];
  [gAcel.data.datasets[0].data, gAcel.data.datasets[1].data, gAcel.data.datasets[2].data, gAcel.data.datasets[3].data] = [col('ax'), col('ay'), col('az'), col('a_mag')];
  [gEnlace.data.datasets[0].data, gEnlace.data.datasets[1].data] = [col('rssi'), col('snr')];
  [gAmb.data.datasets[0].data, gAmb.data.datasets[1].data] = [col('temp'), col('hum')];
  [gGas.data.datasets[0].data, gGas.data.datasets[1].data] = [col('gas_mv'), col('alt_gps')];
  gUV.data.datasets[0].data = col('uv');
  [gOri, gGiro, gAcel, gEnlace, gAmb, gGas, gUV].forEach((g) => g.update('none'));
  pintarKPIs();
  pintarAmbiente();
  pintarActitud(historial[historial.length - 1]);
  pintarHalo();
}

// ---------- Actitud: vista 3D, brújula, horizonte y calibración ----------
(function construirInstrumentos() {
  // Marcas de la brújula cada 10°
  let marcas = '';
  for (let g = 0; g < 360; g += 10) {
    const largo = g % 90 === 0 ? 12 : g % 30 === 0 ? 8 : 4;
    marcas += `<line x1="100" y1="12" x2="100" y2="${12 + largo}" transform="rotate(${g} 100 100)" class="${g % 30 === 0 ? 'm-fuerte' : 'm'}" />`;
  }
  $('brujula-marcas').innerHTML = marcas;

  // Escala de cabeceo del horizonte (1 grado = 2 px)
  let escala = '';
  for (let g = -40; g <= 40; g += 10) {
    if (!g) continue;
    const y = 100 - g * 2, w = g % 20 === 0 ? 30 : 16;
    escala += `<line x1="${100 - w}" y1="${y}" x2="${100 + w}" y2="${y}" class="esc-h" />`;
    if (g % 20 === 0) escala += `<text x="${100 + w + 6}" y="${y + 4}" class="esc-t">${Math.abs(g)}</text>`;
  }
  $('escala-cabeceo').innerHTML = escala;
})();

function pintarActitud(p) {
  const rumbo = p?.rumbo ?? 0, alabeo = p?.alabeo ?? 0, cabeceo = p?.cabeceo ?? 0;
  const conOri = p && p.rumbo !== null && p.rumbo !== undefined;
  ejes3d.objetivo(p);
  $('aguja').setAttribute('transform', `rotate(${rumbo} 100 100)`);
  $('brujula-valor').textContent = conOri ? `Rumbo ${fmt(rumbo)}° ${cardinal(rumbo)}` : 'Rumbo —';
  $('horizonte').setAttribute('transform', `rotate(${-alabeo} 100 100) translate(0 ${clamp(cabeceo, -45, 45) * 2})`);
  $('h-alabeo').textContent = conOri ? `${fmt(alabeo)}°` : '—';
  $('h-cabeceo').textContent = conOri ? `${fmt(cabeceo)}°` : '—';
  $('hud-actitud').textContent = conOri ? `rumbo ${fmt(rumbo, 0)}° · alabeo ${fmt(alabeo)}° · cabeceo ${fmt(cabeceo)}°` : 'Esperando orientación del BNO055';

  pintarGuiaCalibracion(p);
}

// Guía de calibración: qué hacer con cada sensor y cómo va
const PASOS_CAL = [
  { k: 'cal_giro', n: 'Giroscopio', tiempo: '2–5 s', paso: 'Deja el CanSat completamente quieto sobre la mesa.' },
  { k: 'cal_acel', n: 'Acelerómetro', tiempo: '30–60 s', paso: 'Ponlo quieto 2–3 s en 6 posiciones: boca arriba, boca abajo y sobre cada uno de sus 4 lados (como las caras de un dado). Muévelo despacio entre una y otra.' },
  { k: 'cal_mag', n: 'Magnetómetro', tiempo: '10–30 s', paso: 'En la mano, lejos (≥ 50 cm) de laptop, metal, imanes, cables y la batería: dibuja ochos grandes en el aire girándolo en todos los sentidos.' },
  { k: 'cal_sys', n: 'Sistema', tiempo: 'automático', paso: 'Sube solo cuando los otros tres están bien. Si se queda abajo, repite el magnetómetro en otro lugar.' },
];
// Segundos que lleva el sensor en su valor actual (según las lecturas recibidas)
function segundosEnValor(k) {
  const n = historial.length;
  if (!n || historial[n - 1][k] === null || historial[n - 1][k] === undefined) return null;
  let i = n - 1;
  while (i > 0 && historial[i - 1][k] === historial[n - 1][k]) i--;
  return Math.round((historial[n - 1].t - historial[i].t) / 1000);
}
function pintarGuiaCalibracion(p) {
  const valores = PASOS_CAL.map((x) => p?.[x.k]);
  const hay = valores.every((v) => v !== null && v !== undefined);
  const siguiente = hay ? PASOS_CAL.findIndex((x) => p[x.k] < 3) : -1;
  $('cal-resumen').textContent = !hay ? (p ? 'el firmware no envía calibración' : 'esperando datos')
    : siguiente === -1 ? '✓ todo calibrado (el Nodo A la guarda en memoria)' : `S·G·A·M = ${p.cal_sys}·${p.cal_giro}·${p.cal_acel}·${p.cal_mag}`;
  $('cal-pasos').innerHTML = PASOS_CAL.map((x, i) => {
    const v = p?.[x.k];
    const conV = v !== null && v !== undefined;
    const estado = !conV ? '' : v === 3 ? 'hecho' : i === siguiente ? 'actual' : '';
    const seg = [1, 2, 3].map((j) => `<i class="${conV && v >= j ? 'on c' + v : ''}"></i>`).join('');
    const t = segundosEnValor(x.k);
    const nota = !conV ? '' : v === 3 ? `listo · en 3 desde hace ${t ?? 0} s` : `nivel ${v} desde hace ${t ?? 0} s`;
    return `<div class="cal-paso ${estado}">
      <div class="cal-num">${v === 3 ? '✓' : i + 1}</div>
      <div class="cal-texto"><b>${x.n}</b> <small class="tenue">· ${x.tiempo}</small>
        <p>${x.paso}</p></div>
      <div class="cal-estado"><span class="segmentos">${seg}</span><b>${conV ? v : '—'}</b><small>${nota}</small></div>
    </div>`;
  }).join('');
}

// ---------- Vista 3D: esfera con los ejes X/Y/Z del sensor ----------
// Usa el cuaternión del BNO055 (o los ángulos de Euler si el firmware no lo manda).
// Ejes de referencia fijos + esfera y ejes del sensor que giran con él + vector ω.
const ejes3d = (() => {
  const cv = $('ejes3d');
  const ctx = cv.getContext('2d');
  const VISTA = { az: 0.65, el: 0.35 };
  let az = VISTA.az, el = VISTA.el;
  let qAct = [1, 0, 0, 0], qObj = [1, 0, 0, 0], omega = [0, 0, 0], conDatos = false;
  const quieto = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Arrastrar para girar la vista; doble clic para volver a la inicial
  let arrastre = null;
  cv.addEventListener('pointerdown', (e) => { arrastre = { x: e.clientX, y: e.clientY, az, el }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!arrastre) return;
    az = arrastre.az + (e.clientX - arrastre.x) * 0.01;
    el = clamp(arrastre.el + (e.clientY - arrastre.y) * 0.01, -1.45, 1.45);
  });
  cv.addEventListener('pointerup', () => (arrastre = null));
  cv.addEventListener('dblclick', () => { az = VISTA.az; el = VISTA.el; });

  const RAD = Math.PI / 180;
  const qNorm = (q) => { const n = Math.hypot(...q) || 1; return q.map((c) => c / n); };
  const qMul = ([a0, a1, a2, a3], [b0, b1, b2, b3]) => [
    a0 * b0 - a1 * b1 - a2 * b2 - a3 * b3, a0 * b1 + a1 * b0 + a2 * b3 - a3 * b2,
    a0 * b2 - a1 * b3 + a2 * b0 + a3 * b1, a0 * b3 + a1 * b2 - a2 * b1 + a3 * b0,
  ];
  const qEje = ([x, y, z], ang) => [Math.cos(ang / 2), x * Math.sin(ang / 2), y * Math.sin(ang / 2), z * Math.sin(ang / 2)];
  function slerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) { b = b.map((c) => -c); d = -d; }
    if (d > 0.9995) return qNorm(a.map((c, i) => c + (b[i] - c) * t));
    const th = Math.acos(d), s = Math.sin(th);
    return a.map((c, i) => (Math.sin((1 - t) * th) * c + Math.sin(t * th) * b[i]) / s);
  }
  // Rota un vector del marco del sensor al marco de referencia
  function rotar([w, x, y, z], [vx, vy, vz]) {
    return [
      (1 - 2 * (y * y + z * z)) * vx + 2 * (x * y - w * z) * vy + 2 * (x * z + w * y) * vz,
      2 * (x * y + w * z) * vx + (1 - 2 * (x * x + z * z)) * vy + 2 * (y * z - w * x) * vz,
      2 * (x * z - w * y) * vx + 2 * (y * z + w * x) * vy + (1 - 2 * (x * x + y * y)) * vz,
    ];
  }

  function objetivo(p) {
    if (!p) { conDatos = false; return; }
    if (p.qw !== null && p.qw !== undefined) {
      qObj = qNorm([p.qw, p.qx, p.qy, p.qz]);
      conDatos = true;
    } else if (p.rumbo !== null && p.rumbo !== undefined) {
      // Sin cuaternión: rumbo sobre Z, cabeceo sobre X, alabeo sobre Y (convención del BNO055)
      qObj = qNorm(qMul(qMul(qEje([0, 0, 1], -p.rumbo * RAD), qEje([1, 0, 0], p.cabeceo * RAD)), qEje([0, 1, 0], p.alabeo * RAD)));
      conDatos = true;
    } else {
      conDatos = false;
    }
    omega = [p.wx ?? 0, p.wy ?? 0, p.wz ?? 0];
    if (quieto) qAct = qObj;
  }

  function dibujar() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = cv.clientWidth * dpr, H = cv.clientHeight * dpr;
    if (!W || !H) return;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    ctx.clearRect(0, 0, W, H);
    const S = Math.min(W, H) * 0.27;
    const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    const proy = ([x, y, z]) => {
      const x1 = x * ca - y * sa, y1 = x * sa + y * ca;
      const arriba = y1 * se + z * ce, prof = y1 * ce - z * se;
      const f = 4 / (4 + prof);
      return [W / 2 + x1 * S * f, H / 2 - arriba * S * f, prof];
    };
    const linea = (a, b, color, ancho, guiones) => {
      const [x1, y1] = proy(a), [x2, y2] = proy(b);
      ctx.beginPath(); ctx.setLineDash(guiones || []); ctx.strokeStyle = color; ctx.lineWidth = ancho * dpr;
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
    };
    const flecha = (fin, color, etiqueta, ancho = 3) => {
      const [x0, y0] = proy([0, 0, 0]), [x1, y1, prof] = proy(fin);
      const ang = Math.atan2(y1 - y0, x1 - x0), t = 11 * dpr;
      ctx.save();
      ctx.globalAlpha = prof > 0.6 ? 0.55 : 1;
      ctx.shadowColor = color; ctx.shadowBlur = 10 * dpr;
      ctx.strokeStyle = ctx.fillStyle = color; ctx.lineWidth = ancho * dpr;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - t * Math.cos(ang - 0.4), y1 - t * Math.sin(ang - 0.4));
      ctx.lineTo(x1 - t * Math.cos(ang + 0.4), y1 - t * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.font = `600 ${13 * dpr}px "Space Grotesk", sans-serif`;
      ctx.fillText(etiqueta, x1 + 8 * dpr * Math.cos(ang) - 4 * dpr, y1 + 8 * dpr * Math.sin(ang) + 4 * dpr);
      ctx.restore();
    };

    // Halo detrás de la esfera
    const [cx, cy] = proy([0, 0, 0]);
    const halo = ctx.createRadialGradient(cx, cy, S * 0.6, cx, cy, S * 1.9);
    halo.addColorStop(0, 'rgba(92, 200, 255, 0.22)');
    halo.addColorStop(1, 'rgba(92, 200, 255, 0)');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);

    // Ejes de referencia (fijos)
    const L = 1.75, ref = 'rgba(110, 168, 255, 0.55)';
    [[1, 0, 0, 'X₀'], [0, 1, 0, 'Y₀'], [0, 0, 1, 'Z₀']].forEach(([x, y, z, n]) => {
      linea([-x * L, -y * L, -z * L], [x * L, y * L, z * L], ref, 1.2, [6 * dpr, 5 * dpr]);
      const [px, py] = proy([x * L * 1.06, y * L * 1.06, z * L * 1.06]);
      ctx.fillStyle = ref; ctx.font = `500 ${12 * dpr}px Inter, sans-serif`; ctx.fillText(n, px + 3 * dpr, py + 4 * dpr);
    });

    // Esfera de alambre fija al sensor (gira con él)
    const q = qAct;
    const color = conDatos ? '150, 230, 255' : '140, 155, 175';
    ctx.lineWidth = 1 * dpr;
    const tramo = (pts) => {
      for (let i = 1; i < pts.length; i++) {
        const a = proy(rotar(q, pts[i - 1])), b = proy(rotar(q, pts[i]));
        const prof = (a[2] + b[2]) / 2;
        ctx.strokeStyle = `rgba(${color}, ${prof < 0 ? 0.6 : 0.16})`;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    };
    for (let la = -60; la <= 60; la += 30) {
      const pts = [];
      for (let lo = 0; lo <= 360; lo += 10) pts.push([Math.cos(la * RAD) * Math.cos(lo * RAD), Math.cos(la * RAD) * Math.sin(lo * RAD), Math.sin(la * RAD)]);
      tramo(pts);
    }
    for (let lo = 0; lo < 180; lo += 30) {
      const pts = [];
      for (let la = 0; la <= 360; la += 10) pts.push([Math.cos(la * RAD) * Math.cos(lo * RAD), Math.cos(la * RAD) * Math.sin(lo * RAD), Math.sin(la * RAD)]);
      tramo(pts);
    }

    // Ejes del sensor (del más lejano al más cercano) y vector de velocidad angular
    const ejes = [[[1, 0, 0], '#ff5c6c', 'X'], [[0, 1, 0], '#5be37a', 'Y'], [[0, 0, 1], '#4f8dff', 'Z']]
      .map(([v, c, n]) => { const w = rotar(q, v.map((k) => k * 1.5)); return { w, c, n, prof: proy(w)[2] }; })
      .sort((a, b) => b.prof - a.prof);
    if (conDatos) ejes.forEach((e) => flecha(e.w, e.c, e.n));
    const wMag = Math.hypot(...omega);
    if (conDatos && wMag > 2) {
      const largo = clamp(wMag / 90, 0.25, 1.6);
      const dir = rotar(q, omega.map((k) => (k / wMag) * largo));
      flecha(dir, '#ffd84a', `ω ${fmt(wMag, 0)}°/s`, 2.5);
    }
    if (!conDatos) {
      ctx.fillStyle = 'rgba(232, 241, 251, 0.7)'; ctx.font = `500 ${13 * dpr}px Inter, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText('Esperando orientación del BNO055', W / 2, H - 14 * dpr); ctx.textAlign = 'start';
    }
  }

  function bucle() {
    if (!document.hidden) {
      qAct = slerp(qAct, qObj, 0.18);   // movimiento suave entre un paquete y el siguiente
      dibujar();
    }
    requestAnimationFrame(bucle);
  }
  requestAnimationFrame(bucle);
  return { objetivo };
})();

// ================= Conexión con la API =================
// Intervalo típico entre paquetes (mediana de los últimos), para saber si la señal sigue viva
function intervaloEstimado() {
  const n = historial.length;
  if (n < 3) return 10;
  const d = [];
  for (let i = Math.max(1, n - 20); i < n; i++) d.push((historial[i].t - historial[i - 1].t) / 1000);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

function estadoConexion() {
  const ult = historial[historial.length - 1];
  const pill = $('conexion');
  const seg = ult ? Math.round((Date.now() - ult.t) / 1000) : null;
  const pie = [];
  if (receptor?.sesion) pie.push(receptor.sesion.nombre);
  if (receptor?.puerto) pie.push(`Nodo B en ${receptor.puerto}`);
  if (ult) pie.push(`último paquete hace ${seg} s`);

  if (!apiEnLinea) { pill.className = 'pastilla alerta'; pill.textContent = 'API Python apagada'; pie.length = 0; pie.push(API); }
  else if (receptor && !receptor.conectado) { pill.className = 'pastilla alerta'; pill.textContent = 'Nodo B desconectado'; pie.unshift(receptor.error || ''); }
  else if (ult && seg < Math.max(3, intervaloEstimado() * 3)) { pill.className = 'pastilla on'; pill.textContent = 'En vivo'; }
  else { pill.className = 'pastilla off'; pill.textContent = ult ? 'Sin señal LoRa' : 'Esperando datos'; }
  $('ultimo').textContent = pie.filter(Boolean).join(' · ');
  $('punto-vivo').className = 'punto-vivo' + (pill.classList.contains('on') ? ' on' : '');
}
setInterval(estadoConexion, 1000);

async function cargarHistorial() {
  try {
    historial = await (await fetch(`${API}/api/historial?n=${MAX_PUNTOS}`)).json();
  } catch { /* la API está apagada */ }
  redibujarTelemetria();
}

let pendienteDibujo = false;
function conectar() {
  const es = new EventSource(API + '/api/stream');
  es.onopen = async () => {
    apiEnLinea = true;
    // Al (re)conectar, recupera lo que llegó mientras no había conexión
    await cargarHistorial();
    cargarSesiones();
    estadoConexion();
  };
  es.onerror = () => { apiEnLinea = false; estadoConexion(); };
  es.addEventListener('estado', (e) => { receptor = JSON.parse(e.data); estadoConexion(); pintarKPIs(); });
  es.addEventListener('lectura', (e) => {
    const p = JSON.parse(e.data);
    historial.push(p);
    if (historial.length > MAX_PUNTOS * 2) historial.splice(0, historial.length - MAX_PUNTOS);
    if (receptor) {
      receptor.lecturas = (receptor.lecturas ?? 0) + 1;
      receptor.perdidos = (receptor.perdidos ?? 0) + (p.perdidos || 0);
    }
    if (!pendienteDibujo) {
      pendienteDibujo = true;
      requestAnimationFrame(() => { pendienteDibujo = false; redibujarTelemetria(); estadoConexion(); });
    }
    bitacoraEnVivo();
  });
  es.addEventListener('evento', () => bitacoraEnVivo());
  es.addEventListener('sesion', async () => {
    historial = [];
    redibujarTelemetria();
    await cargarSesiones(true);
  });
}

async function solicitarLectura() {
  const botones = [$('solicitar'), $('solicitar-2')];
  botones.forEach((b) => (b.disabled = true));
  try {
    const r = await fetch(API + '/api/solicitar', { method: 'POST' });
    if (!r.ok) alert((await r.json()).detail || 'No se pudo solicitar la lectura');
  } catch { alert('La API de Python no está disponible'); }
  setTimeout(() => botones.forEach((b) => (b.disabled = false)), 3000);
}
$('solicitar').addEventListener('click', solicitarLectura);
$('solicitar-2').addEventListener('click', solicitarLectura);

// ================= Bitácora =================
const POR_PAGINA = 25;
let bSesion = null, bPagina = 1, bTotal = 0, sesiones = [];
let recargaPendiente = null;

async function cargarSesiones(irAActual = false) {
  try { sesiones = await (await fetch(API + '/api/sesiones')).json(); } catch { return; }
  const actual = receptor?.sesion?.id ?? sesiones[0]?.id;
  if (irAActual || bSesion === null || !sesiones.some((s) => s.id === bSesion)) { bSesion = actual; bPagina = 1; }
  $('b-sesion').innerHTML = sesiones.map((s) => {
    const fecha = new Date(s.inicio).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
    return `<option value="${s.id}" ${s.id === bSesion ? 'selected' : ''}>${esc(s.nombre)} · ${fecha} · ${s.lecturas} lecturas${s.fin ? '' : ' (actual)'}</option>`;
  }).join('');
  cargarBitacora();
}

async function cargarBitacora() {
  if (bSesion === null) return;
  $('b-csv').href = `${API}/api/bitacora.csv?sesion=${bSesion}`;
  try {
    const [pag, evs] = await Promise.all([
      fetch(`${API}/api/bitacora?sesion=${bSesion}&pagina=${bPagina}&limite=${POR_PAGINA}`).then((r) => r.json()),
      fetch(`${API}/api/bitacora/eventos?sesion=${bSesion}&limite=40`).then((r) => r.json()),
    ]);
    bTotal = pag.total;
    pintarTabla(pag.filas);
    pintarEventos(evs);
  } catch { /* API apagada */ }
}

function pintarTabla(filas) {
  const paginas = Math.max(1, Math.ceil(bTotal / POR_PAGINA));
  $('b-pagina').textContent = `Página ${bPagina} de ${paginas}`;
  $('b-prev').disabled = bPagina <= 1;
  $('b-sig').disabled = bPagina >= paginas;
  const s = sesiones.find((x) => x.id === bSesion);
  $('b-resumen').textContent = s ? `${bTotal} lecturas · ${s.perdidos} perdidas · desde ${fechaHora(s.inicio)}` : '';
  if (!filas.length) { $('b-filas').innerHTML = '<tr><td colspan="22" class="vacio">Sin lecturas en esta sesión</td></tr>'; return; }
  $('b-filas').innerHTML = filas.map((f) => `
    <tr>
      <td>${fechaHora(f.t)}</td><td>${f.seq ?? '—'}</td>
      <td>${fmt(f.rumbo)}</td><td>${fmt(f.alabeo)}</td><td>${fmt(f.cabeceo)}</td>
      <td>${fmt(f.wx)}</td><td>${fmt(f.wy)}</td><td>${fmt(f.wz)}</td><td><b>${fmt(f.w_mag)}</b></td>
      <td>${fmt(f.a_mag, 2)}</td><td class="mono">${calTexto(f)}</td>
      <td>${fmt(f.temp, 0)}</td><td>${fmt(f.hum, 0)}</td><td>${fmt(f.gas_mv, 0)}</td><td>${fmt(f.uv)}</td>
      <td>${fmt(f.lat, 5)}</td><td>${fmt(f.lon, 5)}</td><td>${fmt(f.alt_gps, 0)}</td><td>${fmt(f.sats, 0)}</td>
      <td>${fmt(f.rssi, 0)}</td><td>${fmt(f.snr)}</td>
      <td>${f.perdidos ? `<span class="etiqueta alerta" title="Paquetes que faltaron antes de este">−${f.perdidos}</span>` : ''}${f.formato === 'G' ? '<span class="etiqueta" title="Firmware antiguo">G</span>' : ''}</td>
    </tr>`).join('');
}

const ICONO_EVENTO = { conexion: '🔌', desconexion: '⚠️', perdidos: '📉', invalido: '⛔', duplicado: '♻️', reinicio_nodo_a: '🔄', sesion: '📁', solicitud: '📡', nodo_b: '💬', mensaje_lora: '✉️', serial: '·' };
function pintarEventos(evs) {
  $('b-eventos').innerHTML = evs.length
    ? evs.map((e) => `<li><span class="ev-icono">${ICONO_EVENTO[e.tipo] || '·'}</span><div><small>${fechaHora(e.t)} · ${esc(e.tipo)}</small><p>${esc(e.detalle)}</p></div></li>`).join('')
    : '<li class="vacio">Sin eventos</li>';
}

// Si estás viendo la primera página de la sesión actual, se actualiza sola
function bitacoraEnVivo() {
  if (bSesion !== receptor?.sesion?.id || bPagina !== 1 || recargaPendiente) return;
  recargaPendiente = setTimeout(() => { recargaPendiente = null; cargarBitacora(); }, 800);
}

$('b-sesion').addEventListener('change', () => { bSesion = Number($('b-sesion').value); bPagina = 1; cargarBitacora(); });
$('b-prev').addEventListener('click', () => { if (bPagina > 1) { bPagina--; cargarBitacora(); } });
$('b-sig').addEventListener('click', () => { bPagina++; cargarBitacora(); });
$('b-nueva').addEventListener('click', async () => {
  const nombre = prompt('Nombre de la nueva sesión (ej. "Prueba de caída 1"):\nLa sesión actual se cierra y sus datos quedan guardados en la bitácora.');
  if (nombre === null) return;
  try {
    await fetch(API + '/api/sesiones', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre }) });
  } catch { alert('La API de Python no está disponible'); }
});

// ================= Vista de inicio =================
const conUnidad = (v, u, d = 1) => (v === undefined || v === null ? '—' : `${fmt(v, d)} ${u}`);
const CAMPOS_CAL = ['cal_sys', 'cal_giro', 'cal_acel', 'cal_mag'];

function pintarHalo() {
  const p = historial[historial.length - 1];
  const mov = estadoMovimiento(p);
  $('hud-w').textContent = fmt(p?.w_mag);
  $('hud-fase').textContent = mov;

  // Ficha
  $('f-rumbo').textContent = p?.rumbo !== null && p?.rumbo !== undefined ? `${fmt(p.rumbo, 0)}° ${cardinal(p.rumbo)}` : '—';
  $('f-alabeo').textContent = conUnidad(p?.alabeo, '°');
  $('f-cabeceo').textContent = conUnidad(p?.cabeceo, '°');
  $('f-w').textContent = conUnidad(p?.w_mag, '°/s');
  $('f-temp').textContent = conUnidad(p?.temp, '°C', 0);
  $('f-hum').textContent = conUnidad(p?.hum, '%', 0);
  $('f-gas').textContent = conUnidad(p?.gas_mv, 'mV', 0);
  $('f-uv').textContent = p?.uv !== null && p?.uv !== undefined ? `${fmt(p.uv)} · ${categoriaUV(p.uv)}` : '—';
  $('f-alt').textContent = conUnidad(p?.alt_gps, 'm', 0);
  $('f-rssi').textContent = conUnidad(p?.rssi, 'dBm', 0);
  $('f-seq').textContent = p ? `#${p.seq}` : '—';
  $('f-pkts').textContent = receptor?.lecturas ?? historial.length;
  $('f-cal').innerHTML = ['S', 'G', 'A', 'M'].map((n, i) => {
    const v = p?.[CAMPOS_CAL[i]];
    return `<span class="${v === null || v === undefined ? '' : 'c' + v}">${n}${v ?? '·'}</span>`;
  }).join('');

  // Movimiento
  $('ins-mov').textContent = mov;
  $('ins-mov-chip').className = 'chip' + (!p ? '' : mov === 'Sacudida fuerte' ? ' extremo' : mov === 'Girando' ? ' alto' : ' ok');
  $('ins-mov-chip').querySelector('em').textContent = p ? `|ω| ${fmt(p.w_mag)} °/s · |a| ${fmt(p.a_mag, 2)} m/s²` : 'Esperando paquetes del Nodo A';

  // Enlace LoRa
  const n = receptor?.lecturas ?? historial.length, perd = receptor?.perdidos ?? 0;
  const pctPerd = n + perd > 0 ? (perd / (n + perd)) * 100 : 0;
  $('ins-enlace').textContent = conUnidad(p?.rssi, 'dBm', 0);
  $('ins-enlace-sub').textContent = p?.snr !== null && p?.snr !== undefined ? `SNR ${fmt(p.snr)} dB` : 'RSSI · SNR';
  $('ins-enlace-chip').className = 'chip' + (n === 0 ? '' : pctPerd < 5 ? ' ok' : pctPerd < 20 ? '' : ' alto');
  $('ins-enlace-chip').querySelector('em').textContent = n ? `${n} recibidos · ${perd} perdidos (${fmt(pctPerd, 1)} %)` : 'Sin paquetes en esta sesión';

  // Calibración
  const cal = CAMPOS_CAL.map((k) => p?.[k]);
  const conCal = cal.every((v) => v !== null && v !== undefined);
  $('ins-cal').textContent = conCal ? cal.join(' · ') : '—';
  const chip = $('ins-cal-chip');
  if (!conCal) { chip.className = 'chip'; chip.querySelector('em').textContent = p ? 'El firmware no envía calibración' : '—'; }
  else if (cal.every((v) => v === 3)) { chip.className = 'chip ok'; chip.querySelector('em').textContent = 'Totalmente calibrado'; }
  else if (cal[3] < 3) { chip.className = 'chip'; chip.querySelector('em').textContent = 'Mueve el CanSat en forma de ocho para calibrar el magnetómetro'; }
  else { chip.className = 'chip'; chip.querySelector('em').textContent = 'Calibrando… deja el CanSat quieto unos segundos'; }

  // GPS
  const ultFix = ultimaPosicion();
  const chipGps = $('ins-gps-chip');
  const conFix = p && p.lat !== null && p.lat !== undefined;
  $('ins-gps-sub').textContent = p?.sats !== null && p?.sats !== undefined ? `${p.sats} satélites` + (p.hdop ? ` · HDOP ${fmt(p.hdop)}` : '') : 'NEO-6M';
  $('ins-gps').textContent = conFix ? `${fmt(p.lat, 5)}, ${fmt(p.lon, 5)}` : ultFix ? 'Sin fix ahora' : '—';
  if (!p) { chipGps.className = 'chip'; chipGps.querySelector('em').textContent = '—'; }
  else if (conFix) { chipGps.className = 'chip ok'; chipGps.querySelector('em').textContent = `Altitud ${conUnidad(p.alt_gps, 'm', 0)}`; }
  else if (p.sats === null || p.sats === undefined) { chipGps.className = 'chip alto'; chipGps.querySelector('em').textContent = p.gas_mv === null || p.gas_mv === undefined ? 'El firmware del Nodo A no envía GPS' : 'No llegan datos del GPS (revisa TX → GPIO 23)'; }
  else { chipGps.className = 'chip'; chipGps.querySelector('em').textContent = ultFix ? `Última posición hace ${haceCuanto(ultFix.t)}` : 'Buscando satélites (necesita cielo abierto)'; }

  // Barras por eje
  const filas = [
    ['ωx', p?.wx, 100, '°/s', C.x], ['ωy', p?.wy, 100, '°/s', C.y], ['ωz', p?.wz, 100, '°/s', C.z],
    ['ax', p?.ax, 10, 'm/s²', C.x], ['ay', p?.ay, 10, 'm/s²', C.y], ['az', p?.az, 10, 'm/s²', C.z],
  ];
  $('barras-ejes').innerHTML = filas.map(([nombre, v, max, u, col]) => {
    const vacio = v === undefined || v === null;
    const ancho = vacio ? 0 : clamp((Math.abs(v) / max) * 50, 0, 50);
    const izq = vacio || v >= 0 ? 50 : 50 - ancho;
    return `<div class="fila-factor"><span>${nombre}</span>
      <div class="pista centrada"><i style="--c:${col};left:${izq}%;width:${ancho}%"></i></div>
      <b>${fmt(v, u === '°/s' ? 1 : 2)} <small class="tenue">${u}</small></b></div>`;
  }).join('');
  $('ejes-fuente').textContent = p ? `paquete #${p.seq} · ${horaCorta(p.t)}` : '';
}

// ================= Ambiente y GPS =================
const ultimaPosicion = () => { for (let i = historial.length - 1; i >= 0; i--) if (historial[i].lat !== null && historial[i].lat !== undefined) return historial[i]; return null; };
function haceCuanto(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${fmt(s / 3600, 1)} h`;
}

function pintarAmbiente() {
  const p = historial[historial.length - 1];
  $('a-temp').textContent = fmt(p?.temp, 0);
  $('a-hum').textContent = fmt(p?.hum, 0);
  $('a-gas').textContent = fmt(p?.gas_mv, 0);
  // Cambio del MQ-2 respecto al promedio de las primeras lecturas de la sesión
  const gases = historial.filter((x) => x.gas_mv !== null && x.gas_mv !== undefined).map((x) => x.gas_mv);
  const base = gases.length >= 6 ? gases.slice(0, 6).reduce((a, b) => a + b, 0) / 6 : null;
  $('a-gas-sub').textContent = base && p?.gas_mv !== null && p?.gas_mv !== undefined
    ? `mV · ${p.gas_mv >= base ? '+' : ''}${fmt(((p.gas_mv - base) / base) * 100, 0)} % vs primeras lecturas` : 'mV en la salida AO';
  $('a-uv').textContent = fmt(p?.uv);
  $('a-uv-sub').textContent = p?.uv !== null && p?.uv !== undefined ? `${categoriaUV(p.uv)} · ${p.uv_mv} mV` : 'UVM30A';
  $('a-alt').textContent = fmt(p?.alt_gps, 0);
  $('a-sats').textContent = fmt(p?.sats, 0);
  $('a-hdop').textContent = p?.hdop !== null && p?.hdop !== undefined ? `HDOP ${fmt(p.hdop)} (menor = mejor)` : 'HDOP —';

  const ult = ultimaPosicion();
  const conFix = p && p.lat !== null && p.lat !== undefined;
  $('a-pos').textContent = ult ? `${fmt(ult.lat, 5)}, ${fmt(ult.lon, 5)}` : 'Sin fix';
  $('a-pos-sub').textContent = !ult ? 'esperando al GPS' : conFix ? 'posición actual' : `última posición, hace ${haceCuanto(ult.t)}`;
  $('a-maps').textContent = ult ? 'Abrir en Google Maps ↗' : '';
  $('a-maps').href = ult ? `https://www.google.com/maps?q=${ult.lat},${ult.lon}` : '#';
  pintarMapa();
}

// Mapa con Leaflet (si no hay internet, solo se muestran las coordenadas)
let mapa = null, trazo = null, marcador = null, mapaCentrado = false;
function pintarMapa() {
  const puntos = historial.filter((x) => x.lat !== null && x.lat !== undefined).map((x) => [x.lat, x.lon]);
  if (mapa && !puntos.length) { trazo.setLatLngs([]); mapaCentrado = false; return; }
  if (!puntos.length || typeof L === 'undefined') {
    if (typeof L === 'undefined') $('mapa-vacio').textContent = 'No se pudo cargar el mapa (¿sin internet?). Las coordenadas siguen apareciendo arriba y en la bitácora.';
    return;
  }
  if (!mapa) {
    $('mapa-vacio').remove();
    mapa = L.map('mapa', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapa);
    trazo = L.polyline([], { color: '#5ce1ff', weight: 3, opacity: 0.85 }).addTo(mapa);
    marcador = L.circleMarker(puntos[0], { radius: 8, color: '#c8f560', weight: 3, fillColor: '#c8f560', fillOpacity: 0.6 }).addTo(mapa);
  }
  trazo.setLatLngs(puntos);
  marcador.setLatLng(puntos[puntos.length - 1]);
  if (!mapaCentrado) { mapa.setView(puntos[puntos.length - 1], 17); mapaCentrado = true; }
}

// Resalta la sección visible en la barra de navegación
const enlaces = [...document.querySelectorAll('#nav a')];
const observador = new IntersectionObserver((entradas) => {
  for (const e of entradas) if (e.isIntersecting) enlaces.forEach((a) => a.classList.toggle('activo', a.hash === '#' + e.target.id));
}, { rootMargin: '-45% 0px -50% 0px' });
document.querySelectorAll('.app > section').forEach((sec) => observador.observe(sec));

// ================= Arranque =================
redibujarTelemetria();
estadoConexion();
conectar();
