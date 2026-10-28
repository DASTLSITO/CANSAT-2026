# COSTA · Estación terrena

Dashboard para el CanSat COSTA. Muestra únicamente la telemetría del **BNO055** recibida por LoRa (orientación, velocidad angular, aceleración lineal y calibración) y la guarda en una **bitácora SQLite**.

## Arquitectura

```
 CanSat                       Estación terrena (PC)
┌─────────────────┐  LoRa   ┌───────────────┐  USB   ┌────────────────────┐  SSE   ┌─────────────┐
│ Nodo A (Heltec) │ ──────► │ Nodo B (TTGO) │ ─────► │ API Python :8000   │ ─────► │ Dashboard   │
│ BNO055 (NDOF)   │ ◄────── │ RX,rssi,snr,… │ ◄───── │ api/costa_api.py   │ ◄───── │ (navegador) │
└─────────────────┘ ACK/REQ └───────────────┘  REQ   │ data/bitacora.db   │  REST  └──────┬──────┘
                                                     └────────────────────┘               │ HTML
                                                       Node :3000 (server.js) ◄───────────┘
```

| Parte | Archivo | Qué hace |
|---|---|---|
| Nodo A | `arduino/nodoA_heltec/nodoA_heltec.ino` | Lee el BNO055 y transmite cada 10 s (o con el botón, o cuando el Nodo B lo pide) |
| Nodo B | `arduino/nodoB_ttgo/nodoB_ttgo.ino` | Recibe por LoRa y escribe cada paquete por USB con RSSI y SNR; acepta el comando `REQ` |
| API Python | `api/costa_api.py`, `api/bitacora.py` | Lee el puerto serial, guarda todo en SQLite y lo entrega al dashboard |
| Servidor Node | `server.js` | Sirve el dashboard |

## Paquete LoRa del Nodo A

```
B,seq,rumbo,alabeo,cabeceo,wx,wy,wz,ax,ay,az,cal
B,42,187.3,-2.1,4.6,0.3,-1.2,15.8,0.04,-0.11,0.20,3323
```

| Campo | Unidad | Origen en el BNO055 |
|---|---|---|
| rumbo, alabeo, cabeceo | ° | `VECTOR_EULER` (requiere modo NDOF) |
| wx, wy, wz | °/s | `VECTOR_GYROSCOPE` |
| ax, ay, az | m/s² | `VECTOR_LINEARACCEL` (sin gravedad) |
| cal | 4 dígitos | calibración sistema/giro/acel/mag, de 0 a 3 |

El Nodo B lo reenvía por USB como `RX,<rssi>,<snr>,<paquete>`. Las líneas que empiezan con `#` son mensajes informativos y se guardan como eventos. La API también acepta el formato del firmware anterior (`G,...`) para no perder datos si aún no reflasheas el Nodo A; de ese formato solo toma el giroscopio.

> **El BNO055 no da posición.** Da orientación y movimiento. Para posición hace falta un GPS (NEO-6M/M8N) y para altitud un barómetro (BMP280/BME280).

## Instalación (una sola vez)

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt     # Windows: .venv\Scripts\pip install -r requirements.txt
```

Librerías de Arduino: LoRa (Sandeep Mistry), Adafruit BNO055, Adafruit Unified Sensor y ESP8266 and ESP32 OLED driver for SSD1306 (ThingPulse).

Placa a elegir en el Arduino IDE:

| Nodo | Placa | Flash |
|---|---|---|
| Nodo A (Heltec V2) | Heltec WiFi LoRa 32(V2) | 8 MB |
| Nodo B (TTGO LoRa32) | Heltec Wireless Stick Lite / Wireless Shell | 4 MB |

Para el Nodo B no sirven otras placas del core de Heltec:
- **"Heltec WiFi LoRa 32(V2)":** fija 8 MB de flash y el TTGO se queda reiniciando en bucle (`Detected size(4096k) smaller than the size in the binary image header(8192k)`).
- **"Heltec WiFi LoRa 32" (V1) y "WiFi Kit 32":** fuerzan un cristal de 26 MHz (el TTGO tiene uno de 40 MHz), así que el puerto serial sale como basura y la API no entiende nada.

En Linux, si el puerto da "Permission denied": `sudo usermod -aG dialout $USER` y vuelve a iniciar sesión.

## Uso

Terminal 1, la API. Solo se conecta al Nodo B en `/dev/ttyACM0` (para cambiarlo, edita `PUERTO_NODO_B` en `api/costa_api.py`):

```bash
api/.venv/bin/python api/costa_api.py
```

Terminal 2, el dashboard:

```bash
npm start      # http://localhost:3000
```

Cierra el Monitor Serie del Arduino IDE antes de iniciar la API: solo un programa puede abrir el puerto a la vez.

Si la API corre en otra computadora: `http://localhost:3000/?api=http://192.168.1.50:8000`. Documentación interactiva de la API: `http://localhost:8000/docs`.

## Bitácora (SQLite)

Todo lo que llega queda en `data/bitacora.db` y nunca se borra desde el dashboard.

- **Sesiones:** cada prueba o lanzamiento es una sesión. Con "Nueva sesión" se cierra la actual y se abre otra; las anteriores siguen disponibles en el selector de la sección Bitácora.
- **Lecturas:** un renglón por paquete, con hora de recepción, todos los campos, `|ω|`, `|a|`, RSSI, SNR, paquetes perdidos (huecos en `seq`) y la línea original (`crudo`).
- **Eventos:** conexión o desconexión del Nodo B, paquetes perdidos, duplicados o inválidos, reinicios del Nodo A, mensajes del Nodo B y solicitudes de lectura.
- **Exportar:** botón "Exportar CSV" en el dashboard, o `GET /api/bitacora.csv?sesion=N`.

La base también se puede abrir con cualquier visor de SQLite, por ejemplo `sqlite3 data/bitacora.db "SELECT * FROM lecturas ORDER BY t DESC LIMIT 10"`.

| Endpoint | Para qué |
|---|---|
| `GET /api/estado` | Puerto, sesión actual y conteos |
| `GET /api/historial?n=360` | Últimas lecturas de la sesión actual |
| `GET /api/stream` | Lecturas, eventos y estado en vivo (SSE) |
| `POST /api/solicitar` | Pide una lectura inmediata al Nodo A |
| `GET /api/sesiones` · `POST /api/sesiones` | Lista o crea sesiones |
| `GET /api/bitacora?sesion=&pagina=&limite=` | Lecturas paginadas |
| `GET /api/bitacora/eventos?sesion=` | Eventos de una sesión |
| `GET /api/bitacora.csv?sesion=` | Exporta una sesión a CSV |
# CANSAT-2026
