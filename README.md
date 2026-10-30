# Pyro-SCOUT · Estación terrena

Estación terrena del CanSat **Pyro-SCOUT**. Recibe por LoRa la telemetría del CanSat, la guarda en una **bitácora SQLite** y la muestra en un dashboard web:

- **BNO055:** orientación (con vista 3D de los ejes X/Y/Z), velocidad angular, aceleración lineal y calibración.
- **DHT11:** temperatura y humedad.
- **MQ-2:** gases y humo (lectura relativa en mV).
- **UVM30A:** radiación ultravioleta (índice UV).
- **GPS NEO-6M (GY-GPS6MV2):** posición, altitud, satélites y HDOP, con el recorrido en un mapa.

**Misión Pyro-SCOUT:** con esos datos, el dashboard calcula en tiempo real un **índice de riesgo de incendio** (0–100), aplicable a cualquier entorno. Se basa en índices publicados: Chandler Burning Index, Ångström, humedad del combustible de Simard y Fosberg. Suma la insolación UV y el viento estimado por la deriva del GPS, y lanza una **alerta de humo** cuando el MQ-2 sube de forma anómala. Muestra cada factor con su fuente y un mapa de dónde coinciden los factores de riesgo. Es un índice orientativo, no una probabilidad calibrada.

> **Guía completa del proyecto:** [`docs/GUIA_PYRO-SCOUT.md`](docs/GUIA_PYRO-SCOUT.md). Explica cada sensor, cada variable y qué hacer con ella, las conexiones y la energía, el firmware, el enlace LoRa, la API, el dashboard, la operación y la solución de problemas.

## Arquitectura

```
 CanSat                       Estación terrena (PC)
┌─────────────────┐  LoRa   ┌───────────────┐  USB   ┌──────────────────────┐  SSE   ┌─────────────┐
│ Nodo A (Heltec) │ ──────► │ Nodo B (TTGO) │ ─────► │ API Python :8000     │ ─────► │ Dashboard   │
│ BNO055, DHT11,  │ ◄────── │ RX,rssi,snr,… │ ◄───── │ api/pyroscout_api.py │ ◄───── │ (navegador) │
│ MQ-2, UVM30A,   │ ACK/REQ └───────────────┘  REQ   │ data/bitacora.db     │  REST  └──────┬──────┘
│ GPS             │                                  └──────────────────────┘               │ HTML
└─────────────────┘                                    Node :3000 (server.js) ◄─────────────┘
```

| Parte | Archivo | Qué hace |
|---|---|---|
| Nodo A | `arduino/nodoA_heltec/nodoA_heltec.ino` | Lee todos los sensores y transmite (1 paquete por segundo en el perfil rápido) |
| Nodo B | `arduino/nodoB_ttgo/nodoB_ttgo.ino` | Recibe por LoRa, responde ACK y escribe cada paquete por USB con RSSI y SNR |
| API Python | `api/pyroscout_api.py`, `api/bitacora.py` | Lee `/dev/ttyACM0`, valida, guarda en SQLite y transmite en vivo al dashboard |
| Servidor Node | `server.js` | Sirve el dashboard (`public/`) |
| Riesgo de incendio | `public/riesgo.js` | Cálculo del índice de riesgo y su sección en el dashboard |
| Diagnóstico | `arduino/diagnostico_bno055` | Autotest y datos crudos del BNO055 |
| Batería | `arduino/cargar_pila` | Voltaje y porcentaje de la LiPo en el TTGO |

## Conexiones del Nodo A (Heltec WiFi LoRa 32 V2)

| Sensor | Pin del sensor | Pin del Heltec V2 |
|---|---|---|
| **BNO055** | VIN | 3V3 |
| | GND | GND |
| | SDA | GPIO 4 |
| | SCL | GPIO 15 |
| **DHT11** | VCC | 3V3 |
| | GND | GND |
| | DATA | GPIO 17 |
| **GPS NEO-6M** | VCC | 3V3 |
| | GND | GND |
| | TX | GPIO 23 |
| | RX | GPIO 22 (opcional) |
| **MQ-2** | VCC | 5 V |
| | GND | GND |
| | AO | divisor → GPIO 36 |
| **UVM30A** | VCC | 3V3 |
| | GND | GND |
| | OUT | GPIO 39 (directo) |

**Notas de conexión:**
- **Divisor del MQ-2 (obligatorio):** `AO —[10 kΩ]— GPIO 36 —[15 kΩ]— GND`. Su salida llega a 5 V y el ESP32 solo aguanta 3.3 V.
- **UVM30A:** va directo, porque su salida no pasa de ~1.2 V.
- **MQ-2 con batería:** necesita 5 V reales. El pin de 5 V del Heltec solo tiene voltaje con USB; con batería hace falta un elevador (MT3608).
- **Pines que no deben usar:** 34 y 35 (están conectados al radio LoRa) y los de la pantalla (4, 15, 16 y 21).

## Perfil de radio

Se elige con `#define PERFIL_RADIO` y **debe ser el mismo en el Nodo A y en el Nodo B**:

| Perfil | Radio | Tiempo en el aire | Envío |
|---|---|---|---|
| **1 · Rápido** (por defecto) | SF7, CR 4/5 | ~0.25 s | cada 1 s |
| 2 · Equilibrado | SF9, CR 4/5 | ~0.75 s | cada 2 s |
| 3 · Alcance | SF12, CR 4/8 | ~8 s | cada 15 s |

Hagan una prueba de distancia con el perfil 1. Si el RSSI se acerca a −120 dBm o se pierden muchos paquetes, pasen al 2.

## Calibración del BNO055

**Cómo calibrarlo:** el dashboard (sección Movimiento) tiene una **guía paso a paso** con el estado en vivo de cada sensor:
1. **Giroscopio:** quieto unos segundos.
2. **Acelerómetro:** quieto 2–3 s en 6 posiciones distintas.
3. **Magnetómetro:** ochos en el aire, lejos de metal y aparatos.
4. **Sistema:** sube solo cuando los otros tres están bien.

**Guardado:** el BNO055 olvida su calibración al apagarse. El Nodo A la **guarda en su memoria** cuando llega a 3·3·3·3 y la **restaura al encender**. Para borrarla, mantengan el botón del Nodo A 3 segundos.

## Instalación (una sola vez)

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

**Linux:** el usuario debe estar en el grupo `dialout` (`sudo usermod -aG dialout $USER` y volver a iniciar sesión).

**Arduino IDE:** instalen el core "Heltec ESP32" y estas librerías:
- LoRa (Sandeep Mistry)
- Adafruit BNO055
- Adafruit Unified Sensor
- ESP8266 and ESP32 OLED driver for SSD1306 (ThingPulse)
- DHT sensor library (Adafruit)
- TinyGPSPlus (Mikal Hart)

| Nodo | Placa en el Arduino IDE |
|---|---|
| Nodo A (Heltec V2, 8 MB) | **Heltec WiFi LoRa 32(V2)** |
| Nodo B (TTGO LoRa32, 4 MB) | **Heltec Wireless Stick Lite / Wireless Shell** |

Para el Nodo B no sirven "Heltec WiFi LoRa 32(V2)" (el TTGO se reinicia en bucle) ni "Heltec WiFi LoRa 32" V1 (el puerto serial sale como basura). La guía explica por qué.

## Uso

1. Conecta el Nodo B por USB y cierra el Monitor Serie del Arduino IDE.
2. Inicia la API. Solo se conecta a `/dev/ttyACM0`; para cambiarlo, edita `PUERTO_NODO_B` en `api/pyroscout_api.py`.
```bash
api/.venv/bin/python api/pyroscout_api.py
```
3. Inicia el dashboard en otra terminal:
```bash
npm start
```
4. Abre `http://localhost:3000` y crea una **Nueva sesión**.

**Otras formas de abrirlo:**
- **API en otra computadora:** `http://localhost:3000/?api=http://IP:8000`.
- **Documentación interactiva de la API:** `http://localhost:8000/docs`.

## Bitácora

Todo queda en `data/bitacora.db`, separado por sesiones, y nunca se borra desde el dashboard.

- **Exportar:** "Exportar CSV" en el dashboard.
- **Abrir la base:** con cualquier visor de SQLite.
- **Columnas nuevas:** una bitácora vieja se actualiza sola al iniciar la API, sin perder datos.

El detalle de las tablas, columnas y endpoints está en la [guía, sección 8](docs/GUIA_PYRO-SCOUT.md#8-la-api-en-python).

# CANSAT-2026
