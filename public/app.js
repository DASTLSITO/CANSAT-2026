// ================= Estado =================
// API de Python que lee el Nodo B por USB. Se puede cambiar con ?api=http://otra-ip:8000
const API = new URLSearchParams(location.search).get('api') || `${location.protocol}//${location.hostname}:8000`;
const INTERVALO_NODO_A = 10;   // s entre paquetes (SEND_INTERVAL_MS del Nodo A)
const MAX_PUNTOS = 360;        // puntos visibles en las gráficas (1 h a 10 s por paquete)

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
  temp: '#ff9f6b', hum: '#6ea8ff', gas: '#d16bff', alt: '#5ce1ff',
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
  for (const g of [gOri, gGiro, gAcel, gEnlace, gAmb, gGas]) g.data.labels = etiquetas;
  [gOri.data.datasets[0].data, gOri.data.datasets[1].data, gOri.data.datasets[2].data] = [col('alabeo'), col('cabeceo'), col('rumbo')];
  [gGiro.data.datasets[0].data, gGiro.data.datasets[1].data, gGiro.data.datasets[2].data, gGiro.data.datasets[3].data] = [col('wx'), col('wy'), col('wz'), col('w_mag')];
  [gAcel.data.datasets[0].data, gAcel.data.datasets[1].data, gAcel.data.datasets[2].data, gAcel.data.datasets[3].data] = [col('ax'), col('ay'), col('az'), col('a_mag')];
  [gEnlace.data.datasets[0].data, gEnlace.data.datasets[1].data] = [col('rssi'), col('snr')];
  [gAmb.data.datasets[0].data, gAmb.data.datasets[1].data] = [col('temp'), col('hum')];
  [gGas.data.datasets[0].data, gGas.data.datasets[1].data] = [col('gas_mv'), col('alt_gps')];
  [gOri, gGiro, gAcel, gEnlace, gAmb, gGas].forEach((g) => g.update('none'));
  pintarKPIs();
  pintarAmbiente();
  pintarActitud(historial[historial.length - 1]);
  pintarHalo();
}

// ---------- Actitud: CanSat 3D, brújula, horizonte y calibración ----------
(function construirInstrumentos() {
  // Lata de 12 caras hecha con transformaciones CSS 3D
  const lata = $('cansat3d');
  const N = 12, R = 56, alto = 180;
  const lado = 2 * R * Math.sin(Math.PI / N), apotema = R * Math.cos(Math.PI / N);
  let html = '';
  for (let i = 0; i < N; i++) {
    const frente = i === 0 ? ' frente' : '';
    html += `<div class="cara${frente}" style="width:${lado + 0.6}px;height:${alto}px;margin-left:${-lado / 2}px;margin-top:${-alto / 2}px;transform:rotateY(${(360 / N) * i}deg) translateZ(${apotema}px)">${i === 0 ? '<span>▲</span>' : ''}</div>`;
  }
  html += `<div class="tapa" style="width:${2 * R}px;height:${2 * R}px;margin:${-R}px 0 0 ${-R}px;transform:rotateX(90deg) translateZ(${alto / 2}px)"><span>COSTA</span></div>`;
  html += `<div class="tapa abajo" style="width:${2 * R}px;height:${2 * R}px;margin:${-R}px 0 0 ${-R}px;transform:rotateX(-90deg) translateZ(${alto / 2}px)"></div>`;
  html += `<div class="eje" style="height:${alto + 70}px;margin-top:${-(alto + 70) / 2}px"></div>`;
  lata.innerHTML = html;

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
  $('cansat3d').style.transform = `rotateX(-14deg) rotateY(${-rumbo}deg) rotateX(${cabeceo}deg) rotateZ(${alabeo}deg)`;
  $('cansat3d').classList.toggle('sin-datos', !conOri);
  $('aguja').setAttribute('transform', `rotate(${rumbo} 100 100)`);
  $('brujula-valor').textContent = conOri ? `Rumbo ${fmt(rumbo)}° ${cardinal(rumbo)}` : 'Rumbo —';
  $('horizonte').setAttribute('transform', `rotate(${-alabeo} 100 100) translate(0 ${clamp(cabeceo, -45, 45) * 2})`);
  $('h-alabeo').textContent = conOri ? `${fmt(alabeo)}°` : '—';
  $('h-cabeceo').textContent = conOri ? `${fmt(cabeceo)}°` : '—';
  $('hud-actitud').textContent = conOri ? `rumbo ${fmt(rumbo, 0)}° · alabeo ${fmt(alabeo)}° · cabeceo ${fmt(cabeceo)}°` : 'Esperando orientación del BNO055';

  const nombres = [['Sistema', 'cal_sys'], ['Giroscopio', 'cal_giro'], ['Acelerómetro', 'cal_acel'], ['Magnetómetro', 'cal_mag']];
  $('cal-barras').innerHTML = nombres.map(([n, k]) => {
    const v = p?.[k];
    const seg = [1, 2, 3].map((i) => `<i class="${v !== null && v !== undefined && v >= i ? 'on c' + v : ''}"></i>`).join('');
    return `<div class="cal-fila"><span>${n}</span><span class="segmentos">${seg}</span><b>${v ?? '—'}</b></div>`;
  }).join('');
}

// ================= Conexión con la API =================
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
  else if (ult && seg < INTERVALO_NODO_A * 2.5) { pill.className = 'pastilla on'; pill.textContent = 'En vivo'; }
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
  if (!filas.length) { $('b-filas').innerHTML = '<tr><td colspan="21" class="vacio">Sin lecturas en esta sesión</td></tr>'; return; }
  $('b-filas').innerHTML = filas.map((f) => `
    <tr>
      <td>${fechaHora(f.t)}</td><td>${f.seq ?? '—'}</td>
      <td>${fmt(f.rumbo)}</td><td>${fmt(f.alabeo)}</td><td>${fmt(f.cabeceo)}</td>
      <td>${fmt(f.wx)}</td><td>${fmt(f.wy)}</td><td>${fmt(f.wz)}</td><td><b>${fmt(f.w_mag)}</b></td>
      <td>${fmt(f.a_mag, 2)}</td><td class="mono">${calTexto(f)}</td>
      <td>${fmt(f.temp, 0)}</td><td>${fmt(f.hum, 0)}</td><td>${fmt(f.gas_mv, 0)}</td>
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
