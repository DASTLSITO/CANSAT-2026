// ================= Riesgo de incendio · misión Pyro-SCOUT =================
// Se carga después de app.js (usa historial, Chart, C, fmt, clamp, $, serie y ejeDer).
// Cada fórmula viene de un índice de peligro de incendio publicado; la sección
// "Metodología" del dashboard y docs/GUIA_PYRO-SCOUT.md las explican con sus fuentes.
// Es un índice ORIENTATIVO de 0 a 100, no una probabilidad calibrada.

// ---------- Índices meteorológicos (T en °C, HR en %) ----------

// Chandler Burning Index (Chandler et al., 1983, "Fire in Forestry")
function indiceChandler(T, HR) {
  return (((110 - 1.373 * HR) - 0.54 * (10.20 - T)) * (124 * Math.pow(10, -0.0142 * HR))) / 60;
}
function categoriaChandler(v) {
  return v < 50 ? 'Bajo' : v < 75 ? 'Moderado' : v < 90 ? 'Alto' : v < 97.5 ? 'Muy alto' : 'Extremo';
}

// Índice de Ångström (Suecia, años 40): menor = condiciones más favorables al fuego
function indiceAngstrom(T, HR) {
  return HR / 20 + (27 - T) / 10;
}
function categoriaAngstrom(i) {
  return i < 2 ? 'Incendio muy probable' : i < 2.5 ? 'Condiciones favorables al fuego'
    : i <= 4 ? 'Condiciones poco favorables' : 'Incendio improbable';
}

// Humedad de equilibrio del combustible fino muerto, % (Simard, 1968). Usa °F internamente.
function humedadCombustible(T, HR) {
  const F = (T * 9) / 5 + 32;
  if (HR < 10) return 0.03229 + 0.281073 * HR - 0.000578 * HR * F;
  if (HR < 50) return 2.22749 + 0.160107 * HR - 0.01478 * F;
  return 21.0606 + 0.005565 * HR * HR - 0.00035 * HR * F - 0.483199 * HR;
}
function categoriaCombustible(m) {
  return m < 6 ? 'Muy seco' : m < 10 ? 'Seco' : m < 15 ? 'Moderado' : 'Húmedo';
}

// Fosberg Fire Weather Index (Fosberg, 1978): agrega el viento (mph internamente)
function indiceFosberg(T, HR, vientoKmh) {
  const x = Math.min(humedadCombustible(T, HR), 30) / 30;
  const eta = 1 - 2 * x + 1.5 * x * x - 0.5 * x * x * x;
  const U = vientoKmh / 1.609;
  return (eta * Math.sqrt(1 + U * U)) / 0.3002;
}

// ---------- Datos derivados de los otros sensores ----------

const mediana = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

function distanciaM(a, b) {   // fórmula del haversine
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Viento ≈ deriva horizontal del CanSat colgando del paracaídas (últimos 45 s con fix)
function vientoPorGPS(hist) {
  const fin = hist[hist.length - 1];
  if (!fin) return null;
  const pts = hist.filter((p) => p.lat !== null && p.lat !== undefined && fin.t - p.t <= 45000);
  if (pts.length < 3) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const seg = (b.t - a.t) / 1000;
  if (seg < 10) return null;
  const metros = distanciaM(a, b);
  const ruido = Math.max(8, 3 * (b.hdop || 1.5));      // menos que esto es ruido del GPS
  return { kmh: metros < ruido ? 0 : (metros / seg) * 3.6, metros, seg };
}

// Explica por qué no hay viento: casi siempre es que el GPS no tiene fix en este momento
function motivoSinViento(p) {
  const fin = ' Sin dato, no entra en el índice.';
  if (p.sats === null || p.sats === undefined) return 'No llegan datos del GPS.' + fin;
  if (p.lat === null || p.lat === undefined) {
    const ult = ultimaPosicion();
    return `GPS sin fix (${p.sats} satélites)` + (ult ? `, última posición hace ${haceCuanto(ult.t)}` : '') +
      '. Necesita cielo abierto.' + fin;
  }
  return 'Juntando posiciones: necesita fix continuo durante al menos 10 s.' + fin;
}

// Humo: subida anómala del MQ-2 sobre su línea base (mediana y MAD de las lecturas previas)
function anomaliaHumo(hist) {
  const vals = hist.map((p) => p.gas_mv).filter((v) => v !== null && v !== undefined);
  if (vals.length < 20) return { lista: false, activa: false, n: vals.length };
  const previas = vals.slice(-80, -5);
  const base = mediana(previas);
  const mad = 1.4826 * mediana(previas.map((v) => Math.abs(v - base)));
  const umbral = base + Math.max(4 * mad, 0.15 * base, 40);
  const actual = vals[vals.length - 1];
  return {
    lista: true, base, umbral, actual,
    activa: vals.slice(-3).every((v) => v > umbral),         // 3 lecturas seguidas: no es un pico suelto
    pct: base > 0 ? ((actual - base) / base) * 100 : 0,
  };
}

// Qué tan confiable es la lectura actual
function calidadMedicion(p) {
  const avisos = [];
  if (p.temp === null || p.temp === undefined || p.hum === null || p.hum === undefined) avisos.push('Falta temperatura o humedad del DHT11');
  else if (p.temp <= 0 || p.temp >= 50) avisos.push('El DHT11 está en el límite de su rango (0–50 °C): la temperatura real puede ser mayor');
  if ((p.w_mag ?? 0) > 120 || (p.a_mag ?? 0) > 12) avisos.push('Lectura tomada durante una maniobra brusca (BNO055)');
  if (p.lat === null || p.lat === undefined) avisos.push('Sin posición GPS: la lectura no se puede ubicar en el mapa');
  if (p.uv === null || p.uv === undefined) avisos.push('Sin dato de radiación UV');
  const nivel = avisos.length === 0 ? 'Alta' : avisos.length <= 2 && p.temp !== null && p.temp !== undefined ? 'Media' : 'Baja';
  return { nivel, avisos };
}

// ---------- Índice compuesto Pyro-SCOUT ----------
const PESOS_RIESGO = { meteo: 0.55, uv: 0.20, viento: 0.25 };
const CATEGORIAS_RIESGO = [
  [30, 'Bajo', '#45d483'], [50, 'Moderado', '#f2c94c'], [70, 'Alto', '#ff7a45'], [85, 'Muy alto', '#ff4d6d'], [Infinity, 'Extremo', '#d16bff'],
];
const categoriaRiesgo = (r) => CATEGORIAS_RIESGO.find(([max]) => r < max);

function evaluarRiesgo(hist) {
  const p = hist[hist.length - 1];
  if (!p || p.temp === null || p.temp === undefined || p.hum === null || p.hum === undefined) return null;
  const T = p.temp, HR = p.hum;
  const chandler = indiceChandler(T, HR);
  const viento = vientoPorGPS(hist);
  const partes = { meteo: clamp(chandler, 0, 100) };
  if (p.uv !== null && p.uv !== undefined) partes.uv = clamp((p.uv / 11) * 100);
  if (viento) partes.viento = clamp((viento.kmh / 40) * 100);
  // Promedio ponderado solo con los componentes disponibles (los pesos se reparten)
  let suma = 0, pesos = 0;
  for (const [k, v] of Object.entries(partes)) { suma += v * PESOS_RIESGO[k]; pesos += PESOS_RIESGO[k]; }
  let indice = suma / pesos;
  const humo = anomaliaHumo(hist);
  if (humo.activa) indice = Math.max(indice, 70);            // humo detectado: al menos "Muy alto"
  return {
    p, indice, cat: categoriaRiesgo(indice), partes, pesosUsados: pesos,
    chandler, angstrom: indiceAngstrom(T, HR), combustible: humedadCombustible(T, HR),
    fosberg: viento ? indiceFosberg(T, HR, viento.kmh) : null, viento, humo,
    regla30: { temp: T > 30, hum: HR < 30, viento: viento ? viento.kmh > 30 : null },
    calidad: calidadMedicion(p),
  };
}

// ---------- Interfaz ----------
const gRiesgo = new Chart($('g-riesgo'), {
  type: 'line',
  data: { labels: [], datasets: [
    serie('Índice Pyro-SCOUT', '#ff7a45', { fill: true, backgroundColor: 'rgba(255, 122, 69, 0.12)', spanGaps: true }),
    serie('Chandler (CBI)', '#f2c94c', { borderDash: [4, 4], spanGaps: true }),
  ] },
  options: { scales: { y: { min: 0, suggestedMax: 100, title: { display: true, text: 'índice' } } } },
});
const gPerfil = new Chart($('g-perfil'), {
  type: 'scatter',
  data: { datasets: [
    serie('Temperatura °C', C.temp, { xAxisID: 'x', pointRadius: 3 }),
    serie('Humedad %', C.hum, { xAxisID: 'x2', pointRadius: 3 }),
  ] },
  options: {
    interaction: { mode: 'nearest', intersect: true },
    scales: {
      x: { title: { display: true, text: '°C' } },
      x2: { position: 'top', min: 0, max: 100, grid: { display: false }, title: { display: true, text: '% HR' } },
      y: { title: { display: true, text: 'altitud GPS (m)' } },
    },
  },
});

const barra = (v, col) => `<div class="pista"><i style="--c:${col};width:${clamp(v ?? 0)}%"></i></div>`;
function tarjetaFactor(titulo, valor, unidad, etiqueta, puntaje, col, fuente, detalle) {
  return `<div class="vidrio factor-riesgo">
    <div class="fr-cab"><small>${titulo}</small>${etiqueta ? `<span class="etiqueta" style="color:${col}">${etiqueta}</span>` : ''}</div>
    <b>${valor}<small> ${unidad}</small></b>
    ${puntaje === null ? '' : barra(puntaje, col)}
    <p>${detalle}</p>
    <small class="fuente">${fuente}</small>
  </div>`;
}

let ultimaActualizacionMapa = 0, mapaRiesgo = null, capaRiesgo = null, mapaRiesgoCentrado = false;

function pintarRiesgo() {
  const r = evaluarRiesgo(historial);

  // Serie del índice (lecturas recientes, calculando con el historial hasta cada una)
  const v = historial.slice(-MAX_PUNTOS);
  const desde = historial.length - v.length;
  const serieIdx = [], serieCbi = [], porPunto = [];
  v.forEach((p, i) => {
    const e = i >= v.length - 300 ? evaluarRiesgo(historial.slice(0, desde + i + 1)) : null;
    serieIdx.push(e ? +e.indice.toFixed(1) : null);
    serieCbi.push(e ? +clamp(e.chandler, 0, 100).toFixed(1) : null);
    porPunto.push(e);
  });
  gRiesgo.data.labels = v.map((p) => horaCorta(p.t));
  gRiesgo.data.datasets[0].data = serieIdx;
  gRiesgo.data.datasets[1].data = serieCbi;
  gRiesgo.update('none');
  const conAlt = historial.filter((p) => p.alt_gps !== null && p.alt_gps !== undefined);
  gPerfil.data.datasets[0].data = conAlt.filter((p) => p.temp !== null && p.temp !== undefined).map((p) => ({ x: p.temp, y: p.alt_gps }));
  gPerfil.data.datasets[1].data = conAlt.filter((p) => p.hum !== null && p.hum !== undefined).map((p) => ({ x: p.hum, y: p.alt_gps }));
  gPerfil.update('none');

  // Insight del inicio
  const chip = $('ins-riesgo-chip');
  if (!r) {
    $('r-valor').textContent = '—';
    $('r-cat').textContent = 'Sin datos de temperatura y humedad';
    $('r-angstrom').textContent = '';
    $('r-confianza').textContent = '';
    $('r-alerta').hidden = true;
    $('r-factores').innerHTML = '<p class="tenue">El índice necesita al menos temperatura y humedad del DHT11.</p>';
    $('ins-riesgo').textContent = '—';
    chip.className = 'chip'; chip.querySelector('em').textContent = 'Esperando datos del DHT11';
    return;
  }
  const [, nombreCat, colorCat] = r.cat;
  $('ins-riesgo').innerHTML = `<span style="color:${colorCat}">${nombreCat}</span> · ${fmt(r.indice, 0)}/100`;
  $('ins-riesgo-sub').textContent = categoriaAngstrom(r.angstrom);
  chip.className = 'chip' + (r.indice < 30 ? ' ok' : r.indice < 50 ? '' : r.indice < 85 ? ' alto' : ' extremo');
  chip.querySelector('em').textContent = r.humo.activa ? `¡Posible humo! MQ-2 +${fmt(r.humo.pct, 0)} %` : `Confianza ${r.calidad.nivel.toLowerCase()} · ${fmt(r.p.temp, 0)} °C, ${fmt(r.p.hum, 0)} % HR`;

  // Indicador principal
  const arco = $('r-arco');
  const largo = arco.getTotalLength();
  arco.style.strokeDasharray = `${(clamp(r.indice) / 100) * largo} ${largo}`;
  arco.style.stroke = colorCat;
  $('r-valor').textContent = fmt(r.indice, 0);
  $('r-cat').textContent = `Riesgo ${nombreCat.toLowerCase()}`;
  $('r-cat').style.color = colorCat;
  $('r-angstrom').textContent = `Ångström: ${categoriaAngstrom(r.angstrom).toLowerCase()} (${fmt(r.angstrom, 2)})`;
  $('r-confianza').innerHTML = `Confianza de la medición: <b>${r.calidad.nivel}</b>` +
    (r.calidad.avisos.length ? `<ul>${r.calidad.avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '');
  $('r-alerta').hidden = !r.humo.activa;
  if (r.humo.activa) {
    const donde = r.p.lat !== null && r.p.lat !== undefined ? ` en ${fmt(r.p.lat, 5)}, ${fmt(r.p.lon, 5)}` : '';
    $('r-alerta').innerHTML = `<b>⚠ Posible combustión${donde}</b> · el MQ-2 está ${fmt(r.humo.pct, 0)} % sobre su línea base (${fmt(r.humo.base, 0)} mV) durante 3 lecturas seguidas.`;
  }
  const usados = Object.keys(r.partes).map((k) => ({ meteo: 'temperatura y humedad', uv: 'UV', viento: 'viento' }[k]));
  $('r-composicion').textContent = `Calculado con ${usados.join(', ')} · ${historial.length} lecturas`;

  // Factores
  const colCat = (cat) => ({ Bajo: '#45d483', Moderado: '#f2c94c', Alto: '#ff7a45', 'Muy alto': '#ff4d6d', Extremo: '#d16bff' }[cat] || C.texto);
  const cbiCat = categoriaChandler(r.chandler);
  const angCol = r.angstrom < 2 ? '#ff4d6d' : r.angstrom < 2.5 ? '#ff7a45' : r.angstrom <= 4 ? '#f2c94c' : '#45d483';
  const combCat = categoriaCombustible(r.combustible);
  const combCol = { 'Muy seco': '#ff4d6d', Seco: '#ff7a45', Moderado: '#f2c94c', Húmedo: '#45d483' }[combCat];
  const uvCat = categoriaUV(r.p.uv);
  const humoTxt = !r.humo.lista ? `Calculando la línea base (${r.humo.n}/20 lecturas)`
    : r.humo.activa ? `Anomalía: ${fmt(r.humo.actual, 0)} mV, umbral ${fmt(r.humo.umbral, 0)} mV`
    : `Sin anomalía: ${fmt(r.humo.actual, 0)} mV (umbral ${fmt(r.humo.umbral, 0)} mV)`;
  $('r-factores').innerHTML = [
    tarjetaFactor('Peligro meteorológico · Chandler', fmt(r.chandler, 0), 'CBI', cbiCat, clamp(r.chandler, 0, 100), colCat(cbiCat),
      'Chandler et al. (1983) · DHT11', `Temperatura y humedad. Peso en el índice: ${Math.round((PESOS_RIESGO.meteo / r.pesosUsados) * 100)} %.`),
    tarjetaFactor('Probabilidad de incendio · Ångström', fmt(r.angstrom, 2), '', categoriaAngstrom(r.angstrom).replace('Condiciones ', ''), null, angCol,
      'Ångström (Suecia) · DHT11', '< 2.0 muy probable · 2.0–2.5 favorable · 2.5–4.0 poco favorable · > 4.0 improbable.'),
    tarjetaFactor('Humedad del combustible fino', fmt(r.combustible, 1), '%', combCat, clamp(((20 - r.combustible) / 16) * 100), combCol,
      'Simard (1968) · DHT11', 'Humedad que alcanzan la vegetación y los materiales secos con este aire. < 6 % arden con mucha facilidad.'),
    tarjetaFactor('Insolación · radiación UV', fmt(r.p.uv), 'índice UV', uvCat || 'sin dato', r.partes.uv ?? null, colCat(uvCat),
      'OMS · UVM30A', r.partes.uv === undefined ? 'Sin dato: no entra en el índice.' : `Calienta y seca el combustible. Peso: ${Math.round((PESOS_RIESGO.uv / r.pesosUsados) * 100)} %.`),
    tarjetaFactor('Viento · deriva GPS', r.viento ? fmt(r.viento.kmh, 0) : '—', 'km/h', r.fosberg !== null ? `Fosberg ${fmt(r.fosberg, 0)}` : 'sin dato', r.partes.viento ?? null, '#5ce1ff',
      'Fosberg (1978) · NEO-6M',
      r.viento ? `El CanSat se desplazó ${fmt(r.viento.metros, 0)} m en ${fmt(r.viento.seg, 0)} s. Solo equivale al viento mientras cuelga del paracaídas.`
        : motivoSinViento(r.p)),
    tarjetaFactor('Humo · MQ-2', r.humo.lista ? `${r.humo.pct >= 0 ? '+' : ''}${fmt(r.humo.pct, 0)}` : '—', '% vs base', r.humo.activa ? 'ALERTA' : r.humo.lista ? 'normal' : 'calibrando',
      r.humo.lista ? clamp(r.humo.pct * 2) : null, r.humo.activa ? '#ff4d6d' : '#d16bff', 'Mediana y MAD · MQ-2', humoTxt),
  ].join('');

  // Regla 30-30-30
  const marca = (ok, txt) => `<span class="r30 ${ok === null ? 'nd' : ok ? 'si' : 'no'}">${ok === null ? '?' : ok ? '✓' : '✗'} ${txt}</span>`;
  const cumplidas = [r.regla30.temp, r.regla30.hum, r.regla30.viento].filter(Boolean).length;
  $('r-regla30').innerHTML = `<b>Regla 30-30-30:</b> ${marca(r.regla30.temp, `temperatura > 30 °C (${fmt(r.p.temp, 0)})`)}
    ${marca(r.regla30.hum, `humedad < 30 % (${fmt(r.p.hum, 0)})`)}
    ${marca(r.regla30.viento, `viento > 30 km/h (${r.viento ? fmt(r.viento.kmh, 0) : 'sin dato'})`)}
    <small class="tenue">${cumplidas === 3 ? 'Se cumplen las tres: condiciones críticas.' : `Se cumplen ${cumplidas} de 3.`}</small>`;

  // Mapa: cada lectura coloreada por su índice; las anomalías de humo resaltadas
  if (typeof L === 'undefined' || Date.now() - ultimaActualizacionMapa < 3000) return;
  ultimaActualizacionMapa = Date.now();
  const conPos = v.map((p, i) => ({ p, e: porPunto[i] })).filter(({ p, e }) => e && p.lat !== null && p.lat !== undefined);
  if (!conPos.length) { capaRiesgo?.clearLayers(); mapaRiesgoCentrado = false; return; }
  if (!mapaRiesgo) {
    $('mapa-riesgo-vacio').remove();
    mapaRiesgo = L.map('mapa-riesgo');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapaRiesgo);
    capaRiesgo = L.layerGroup().addTo(mapaRiesgo);
  }
  capaRiesgo.clearLayers();
  for (const { p, e } of conPos) {
    const [, cat, col] = e.cat;
    const m = L.circleMarker([p.lat, p.lon], { radius: e.humo.activa ? 9 : 5, color: e.humo.activa ? '#ff4d6d' : col, weight: e.humo.activa ? 3 : 1, fillColor: col, fillOpacity: 0.75 });
    m.bindPopup(`<b>${cat} · ${fmt(e.indice, 0)}/100</b><br>${horaCorta(p.t)} · ${fmt(p.temp, 0)} °C, ${fmt(p.hum, 0)} % HR` +
      (p.uv !== null && p.uv !== undefined ? `, UV ${fmt(p.uv)}` : '') + (e.humo.activa ? `<br>⚠ humo +${fmt(e.humo.pct, 0)} %` : ''));
    capaRiesgo.addLayer(m);
  }
  if (!mapaRiesgoCentrado) { mapaRiesgo.setView([conPos.at(-1).p.lat, conPos.at(-1).p.lon], 16); mapaRiesgoCentrado = true; }
}

window.pintarRiesgo = pintarRiesgo;
pintarRiesgo();
