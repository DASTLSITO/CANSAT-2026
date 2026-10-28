# COSTA · Estación terrena

Dashboard para el CanSat COSTA. Muestra la telemetría recibida por LoRa y la guarda en una **bitácora SQLite**:

- **BNO055:** orientación, velocidad angular, aceleración lineal y calibración.
- **DHT11:** temperatura y humedad.
- **MQ-2:** gases (lectura relativa en mV).
- **GPS NEO-6M (GY-GPS6MV2):** posición, altitud, satélites y HDOP, con el recorrido dibujado en un mapa.

## Arquitectura

```
 CanSat                       Estación terrena (PC)
┌─────────────────┐  LoRa   ┌───────────────┐  USB   ┌────────────────────┐  SSE   ┌─────────────┐
│ Nodo A (Heltec) │ ──────► │ Nodo B (TTGO) │ ─────► │ API Python :8000   │ ─────► │ Dashboard   │
│ BNO055, DHT11,  │ ◄────── │ RX,rssi,snr,… │ ◄───── │ api/costa_api.py   │ ◄───── │ (navegador) │
│ MQ-2, GPS       │ ACK/REQ └───────────────┘  REQ   │ data/bitacora.db   │  REST  └──────┬──────┘
└─────────────────┘
                                                     └────────────────────┘               │ HTML
                                                       Node :3000 (server.js) ◄───────────┘
```

| Parte | Archivo | Qué hace |
|---|---|---|
| Nodo A | `arduino/nodoA_heltec/nodoA_heltec.ino` | Lee todos los sensores y transmite cada 10 s (o con el botón, o cuando el Nodo B lo pide) |
| Nodo B | `arduino/nodoB_ttgo/nodoB_ttgo.ino` | Recibe por LoRa y escribe cada paquete por USB con RSSI y SNR; acepta el comando `REQ` |
| API Python | `api/costa_api.py`, `api/bitacora.py` | Lee el puerto serial, guarda todo en SQLite y lo entrega al dashboard |
| Servidor Node | `server.js` | Sirve el dashboard |

## Conexiones del Nodo A (Heltec WiFi LoRa 32 V2)

| Sensor | Pin del sensor | Pin del Heltec V2 |
|---|---|---|
| **BNO055** | VIN | 3V3 |
| | GND | GND |
| | SDA | GPIO 4 (compartido con la pantalla) |
| | SCL | GPIO 15 (compartido con la pantalla) |
| **DHT11** | VCC (+) | 3V3 |
| | GND (−) | GND |
| | DATA (S / OUT) | GPIO 17 |
| **GPS NEO-6M** (GY-GPS6MV2) | VCC | 3V3 |
| | GND | GND |
| | TX | GPIO 23 |
| | RX | GPIO 22 (opcional; solo para configurar el GPS) |
| **MQ-2** | VCC | 5 V (ver la nota de alimentación) |
| | GND | GND |
| | AO | divisor de voltaje → GPIO 36 |
| | DO | sin conectar |

**Divisor del MQ-2 (obligatorio):** la salida AO llega hasta 5 V y el ESP32 solo aguanta 3.3 V en sus pines. Conecta `AO —[10 kΩ]— GPIO 36 —[15 kΩ]— GND`; así 5 V se convierten en 3 V. Si usas otras resistencias, cambia `MQ2_R_SUP` y `MQ2_R_INF` en el sketch del Nodo A.

**Otras notas:**
- **DHT11:** si es el sensor suelto de 4 patas (no un módulo de 3 pines), pon una resistencia de 10 kΩ entre DATA y 3V3.
- **GPS:** el TX del GPS va al pin que **recibe** del ESP32 (GPIO 23), no a otro TX. Necesita cielo abierto; el primer fix puede tardar de 30 s a varios minutos, y en interiores casi nunca lo consigue.
- **Alimentación del MQ-2:** el calentador consume ~150 mA a 5 V. El pin de 5 V del Heltec solo tiene voltaje con USB conectado. Con batería LiPo necesitas un elevador a 5 V (por ejemplo, un MT3608). Además, el MQ-2 tarda ~2 min en estabilizarse al encenderse (24–48 h la primera vez) y sus lecturas son relativas, no ppm calibradas.
- **Pines que no debes usar:** 5, 14, 18, 19, 26, 27, 34 y 35 (LoRa); 4, 15 y 16 (pantalla); 21 (Vext); 13 (botón); 25 (LED).

## Paquete LoRa del Nodo A

```
B,seq,rumbo,alabeo,cabeceo,wx,wy,wz,ax,ay,az,cal,temp,hum,gas,lat,lon,alt,sats,hdop
B,42,187.3,-2.1,4.6,0.3,-1.2,15.8,0.04,-0.11,0.20,3323,27,61,1180,24.14263,-110.31280,25,7,1.2
```

| Campo | Unidad | Origen |
|---|---|---|
| rumbo, alabeo, cabeceo | ° | BNO055 `VECTOR_EULER` (modo NDOF, reloj interno) |
| wx, wy, wz | °/s | BNO055 `VECTOR_GYROSCOPE` |
| ax, ay, az | m/s² | BNO055 `VECTOR_LINEARACCEL` (sin gravedad) |
| cal | 4 dígitos | calibración sistema/giro/acel/mag del BNO055, de 0 a 3 |
| temp, hum | °C, % | DHT11 (enteros) |
| gas | mV | salida AO del MQ-2, ya corregida por el divisor |
| lat, lon | grados | GPS, 5 decimales (≈1 m) |
| alt | m | altitud GPS sobre el nivel del mar |
| sats, hdop | — | satélites en uso y precisión horizontal (menor = mejor) |

Un campo **vacío** significa que ese dato no está disponible en esa lectura: el DHT11 falló o el GPS aún no tiene fix. Si `sats` también viene vacío, no llega nada del GPS (revisa su cable TX → GPIO 23).

El Nodo B lo reenvía por USB como `RX,<rssi>,<snr>,<paquete>`. Las líneas que empiezan con `#` son mensajes informativos y se guardan como eventos. La API también acepta paquetes `B` de 12 campos (firmware anterior, solo BNO055) y el formato `G,...` del firmware original.

> **Tiempo en el aire:** con SF12, BW 125 kHz y CR 4/8, un paquete de ~100 bytes tarda unos 6 s en transmitirse. Por eso el intervalo de envío no debe bajar de 10 s.

## Instalación (una sola vez)

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt     # Windows: .venv\Scripts\pip install -r requirements.txt
```

Librerías de Arduino (Gestor de librerías): LoRa (Sandeep Mistry), Adafruit BNO055, Adafruit Unified Sensor, ESP8266 and ESP32 OLED driver for SSD1306 (ThingPulse), **DHT sensor library** (Adafruit) y **TinyGPSPlus** (Mikal Hart). Las dos últimas solo las necesita el Nodo A.

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
- **Lecturas:** un renglón por paquete, con hora de recepción, todos los campos (BNO055, DHT11, MQ-2 y GPS), `|ω|`, `|a|`, RSSI, SNR, paquetes perdidos (huecos en `seq`) y la línea original (`crudo`). Una bitácora creada antes de agregar los sensores se actualiza sola al iniciar la API: se agregan las columnas nuevas y no se borra nada.
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
