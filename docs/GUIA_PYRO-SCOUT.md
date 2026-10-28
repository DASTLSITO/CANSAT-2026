# Pyro-SCOUT · Guía completa del proyecto

Todo lo que hay que saber del CanSat Pyro-SCOUT, de lo más específico a lo más general:

1. [Los sensores](#1-los-sensores): qué es cada uno, qué mide, sus límites y cómo se conecta.
2. [Las variables](#2-las-variables): cada dato que llega a la estación terrena, qué significa y qué hacer con él.
3. [Conexiones y energía](#3-conexiones-y-energía): cableado, pines y consumo.
4. [Los microcontroladores](#4-los-microcontroladores): Heltec V2 (Nodo A) y TTGO LoRa32 (Nodo B).
5. [Firmware del Nodo A](#5-firmware-del-nodo-a)
6. [Firmware del Nodo B](#6-firmware-del-nodo-b)
7. [El enlace LoRa](#7-el-enlace-lora): parámetros, perfiles, tiempo en el aire y alcance.
8. [La API en Python](#8-la-api-en-python): lectura del puerto, bitácora SQLite y endpoints.
9. [El dashboard](#9-el-dashboard): estructura, librerías y cómo se dibuja cada cosa.
10. [Operación](#10-operación): instalación, arranque, lista previa al vuelo.
11. [Solución de problemas](#11-solución-de-problemas): todo lo que ya nos pasó y cómo se resolvió.
12. [Visión general](#12-visión-general): arquitectura completa y uso de los datos en la misión.
13. [Glosario](#13-glosario)

> Las cifras de los sensores vienen de sus hojas de datos (Bosch, Aosong, Hanwei, u-blox, Semtech y la del módulo UVM30A). Las de alcance, consumo y autonomía son **aproximadas**: dependen de antenas, batería, temperatura y terreno, y hay que confirmarlas en pruebas.

---

## 1. Los sensores

### 1.1 BNO055 — orientación y movimiento (Bosch)

**Qué es:** una unidad inercial de 9 ejes con un microprocesador interno que hace la **fusión de sensores**. Combina tres sensores en un solo chip:

| Sensor interno | Mide | Rango que usa el modo NDOF |
|---|---|---|
| Acelerómetro | Aceleración (incluida la gravedad) | ±4 g |
| Giroscopio | Velocidad de giro | ±2000 °/s |
| Magnetómetro | Campo magnético (brújula) | ±1300 µT (X, Y), ±2500 µT (Z) |

Con esos tres, su procesador calcula a 100 Hz:
- **Orientación absoluta**, como ángulos de Euler (rumbo, alabeo, cabeceo) y como **cuaternión**.
- **Aceleración lineal**: la aceleración sin la gravedad (lo que el CanSat acelera de verdad).
- **Vector de gravedad**, que no usamos.

**Datos técnicos:**
- **Alimentación:** el chip funciona de 2.4 a 3.6 V. El módulo trae regulador, así que su pin VIN acepta de 3.3 a 5 V. Lo alimentamos a 3.3 V.
- **Consumo:** unos 12 mA en modo NDOF.
- **Interfaz:** I2C en la dirección `0x28` (o `0x29` si el pin ADR está a 3.3 V).
- **Resolución de los ángulos:** 1/16 de grado.
- **Rangos de Euler:** rumbo 0–360°, cabeceo ±180°, alabeo ±90°.

**Modos de operación que importan:**

| Modo | Qué hace | Lo usamos |
|---|---|---|
| `NDOF` | Fusión completa de los 9 ejes: orientación absoluta con rumbo magnético | **Sí** (vuelo) |
| `IMUPLUS` | Fusión sin magnetómetro: orientación relativa, sin norte | No |
| `AMG` | Los 3 sensores en crudo, sin fusión | Solo en el sketch de diagnóstico |
| `GYRONLY` | Solo giroscopio | Era el firmware original |

**Detalles que aprendimos con este módulo:**
- **Usa el reloj interno.** Con `setExtCrystalUse(true)`, nuestro módulo se congela en modo NDOF y entrega **todo en cero**, aunque los modos sin fusión (AMG, GYRONLY) funcionen. El módulo no tiene un cristal externo de 32.768 kHz funcional. Por eso el firmware llama `setExtCrystalUse(false)`. Ver [11.5](#115-bno055-entrega-todo-en-0).
- **El giroscopio ya entrega °/s.** `getVector(VECTOR_GYROSCOPE)` de la librería Adafruit ya da °/s; el firmware original lo multiplicaba por 57.3 por error.
- **No mide posición.** Integrar la aceleración dos veces acumula errores de decenas de metros en segundos. La posición la da el GPS.

**Calibración** (la sección completa está en [5.4](#54-calibración-del-bno055)):
- Cada sensor interno tiene un estado de 0 a 3 (3 = calibrado), más un estado general del sistema.
- **Se pierde al apagar.** El Nodo A la guarda en su memoria al completarla y la restaura al encender.

**Montaje:**
- Fijo y rígido al cuerpo del CanSat, con sus ejes alineados al eje del CanSat. Los ejes vienen dibujados en el módulo.
- Lejos (unos centímetros como mínimo) de imanes, bocinas, la batería, el elevador de voltaje y cables con mucha corriente, porque desvían el magnetómetro.

### 1.2 DHT11 — temperatura y humedad (Aosong)

| Dato | Rango | Precisión | Resolución |
|---|---|---|---|
| Temperatura | 0 a 50 °C | ±2 °C | 1 °C |
| Humedad relativa | 20 a 90 % | ±5 % | 1 % |

**Datos técnicos:**
- **Alimentación:** 3.3 a 5.5 V; lo usamos a 3.3 V. Consume menos de 2.5 mA al medir.
- **Interfaz:** un solo cable de datos con un protocolo propio de pulsos. Necesita una resistencia *pull-up* de 10 kΩ a 3.3 V; los módulos de 3 pines ya la traen.
- **Frecuencia máxima:** una lectura por segundo. La librería Adafruit devuelve la última lectura si se le pide más seguido que cada 2 s, así que con envíos cada 1 s algunos paquetes repiten el valor anterior. Es normal.
- **Respuesta lenta:** tarda varios segundos en seguir un cambio de temperatura, y más aún la humedad.

**Limitaciones importantes para la misión:**
- **No mide arriba de 50 °C ni abajo de 0 °C.** Si Pyro-SCOUT va a medir cerca de calor intenso (fuego, superficies al sol), el DHT11 se satura. Una mejora natural es un **DHT22/AM2302** (−40 a 80 °C, ±0.5 °C) o un **SHT31** (−40 a 125 °C, ±0.3 °C, por I2C).
- **Si se calienta, miente.** Al sol directo o pegado a la placa (el ESP32, el regulador y el MQ-2 se calientan), mide de más. Debe ir sombreado y con aire circulando, por ejemplo detrás de una malla.

### 1.3 MQ-2 — gases combustibles y humo (Hanwei)

**Qué es:** un sensor químico de óxido de estaño (SnO₂) con un **calentador interno**. Cuando hay gases reductores, la resistencia del material baja y el voltaje de salida sube.

**Detecta:** GLP, propano, butano, metano, hidrógeno, alcohol y **humo**, en el rango de unos 300 a 10 000 ppm. No distingue cuál gas es: responde a todos, cada uno con distinta sensibilidad.

**Datos técnicos:**
- **Calentador:** 5.0 V ±0.1 V y unos 150 mA (~0.75 W). **No funciona bien a 3.3 V.**
- **Salida AO del módulo:** analógica de 0 a ~5 V; sube con más gas.
- **Salida DO:** digital, con un umbral que se ajusta con el potenciómetro del módulo. No la usamos.
- **Precalentamiento:** la primera vez que se usa, de 24 a 48 h encendido. Después, de 1 a 3 minutos cada vez que se enciende antes de dar lecturas estables.

**Cómo leemos la salida:**
- **Por qué hace falta un divisor:** el ESP32 solo aguanta 3.3 V en sus pines, así que la salida AO pasa por un divisor de 10 kΩ y 15 kΩ: 5 V × 15/25 = 3.0 V.
- **Qué manda el firmware:** el voltaje **ya corregido**, es decir, el que hay realmente en AO (campo `gas`, en mV).
- **El pin:** **GPIO 36**. No se puede usar el GPIO 34, porque en el Heltec V2 está conectado al radio LoRa (DIO2) y la lectura sale pegada a 0; eso le pasó al firmware original.

**De mV a algo con sentido:**
- **Lectura relativa (lo que hace el dashboard):** compara con las primeras lecturas, en "% vs primeras lecturas". Sirve para ver si el aire cambió.
- **Resistencia del sensor:** `Rs = RL × (5 V − Vout) / Vout`, donde RL es la resistencia de carga del módulo (normalmente 1 kΩ; mírala en la placa, suele estar marcada "102" = 1 kΩ).
- **Calibración en aire limpio:** se mide `Ro` (la Rs en aire limpio, tras precalentar). Según la hoja de datos, en aire limpio `Rs/Ro ≈ 9.8`.
- **ppm:** se estiman con la curva logarítmica de la hoja de datos para cada gas: `ppm = a × (Rs/Ro)^b`, con constantes que dependen del gas. Sin esta calibración, **no son ppm reales**.
- **Le afectan la temperatura y la humedad,** por eso conviene registrarlas junto al gas (ya lo hacemos).

**Montaje:** expuesto al aire, sin taparlo. Se calienta (es normal que esté tibio), así que hay que separarlo del DHT11.

### 1.4 GPS NEO-6M en módulo GY-GPS6MV2 (u-blox)

| Dato | Valor típico |
|---|---|
| Canales | 50 |
| Precisión horizontal | ~2.5 m (CEP, cielo abierto) |
| Precisión de altitud | peor que la horizontal: 5–10 m típico |
| Primer fix (arranque en frío) | ~27 s ideal; en la práctica de 1 a 15 min |
| Arranque en caliente | ~1 s (gracias a la pila de respaldo del módulo) |
| Actualización | 1 Hz por defecto (configurable hasta 5 Hz) |
| Interfaz | UART a 9600 baudios, frases de texto NMEA |
| Alimentación | 3.3–5 V en el módulo; ~45 mA buscando satélites |

**Datos técnicos:**
- **Antena cerámica:** el cuadrito beige. Debe **mirar al cielo**; dentro de edificios casi nunca consigue fix.
- **LED del módulo:** parpadea una vez por segundo cuando tiene fix.
- **Límites:** en modo "portable" (el de fábrica), el NEO-6M funciona hasta 12 km de altitud y 50 m/s de velocidad vertical. Para un CanSat sobra.
- **Lectura:** el firmware usa la librería **TinyGPSPlus**, que interpreta las frases NMEA. Un dato con más de 5 s de antigüedad se trata como "sin fix".

**Montaje:** en la parte superior del CanSat, con la antena hacia arriba y sin metal encima.

### 1.5 UVM30A — radiación ultravioleta

**Qué es:** un módulo con un fotodiodo de nitruro de galio (GaN) que solo responde a la luz ultravioleta (de 200 a 370 nm: UV-A y UV-B), más un amplificador. Entrega un **voltaje proporcional a la intensidad UV**.

| Dato | Valor |
|---|---|
| Alimentación | 3–5 V; lo usamos a 3.3 V. Consumo < 1 mA |
| Salida | Analógica, de 0 a ~1.2 V (índice UV 0 a 11+) |
| Respuesta espectral | 200–370 nm |
| Tiempo de respuesta | < 0.5 s |
| Pin en el Heltec V2 | **GPIO 39**, directo, sin divisor (su salida nunca pasa de ~1.2 V) |

**De mV a índice UV:** la tabla de la hoja de datos del módulo da el voltaje en el que empieza cada índice. La API interpola entre esos puntos (`indice_uv()` en `api/pyroscout_api.py`) y guarda las dos cosas: `uv_mv` (lo medido) y `uv` (el índice).

| Índice UV | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11+ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mV (desde) | < 50 | 227 | 318 | 408 | 503 | 606 | 696 | 795 | 881 | 976 | 1079 | ≥ 1170 |

**Categorías de la OMS** (las usa el dashboard):

| Índice | 0–2 | 3–5 | 6–7 | 8–10 | 11+ |
|---|---|---|---|---|---|
| Categoría | Bajo | Moderado | Alto | Muy alto | Extremo |

**Lectura en el firmware:**
- Se promedian 16 lecturas.
- El ADC usa una atenuación con rango de hasta ~1.75 V (`ADC_6db`). Mide con más resolución que el rango de 3.1 V y no se satura ni con sol extremo.

**Detalles importantes:**
- **Mide hacia donde apunta.** El índice UV oficial se mide con el sensor **mirando al cielo**. Si el CanSat va de lado o de cabeza, la lectura baja. Con la orientación del BNO055 (cabeceo y alabeo cerca de la posición en la que el sensor mira hacia arriba) se pueden separar las lecturas válidas de las que no.
- **No lo tapen con vidrio ni con acrílico común:** bloquean buena parte del UV. Si necesita protección, que sea de un material transparente al UV (cuarzo o PTFE delgado), o déjenlo descubierto detrás de una malla abierta.
- **Es una estimación:** el módulo no está calibrado de fábrica como un radiómetro. Para comparar, se pueden contrastar sus lecturas con el índice UV oficial del día (por ejemplo, el del Servicio Meteorológico Nacional) en un día despejado.

### 1.6 Radio LoRa SX1276 (Semtech), integrado en ambas placas

| Dato | Valor |
|---|---|
| Banda | 915 MHz (ISM de 902–928 MHz, la que se usa en México) |
| Potencia que usamos | 17 dBm (~50 mW) |
| Sensibilidad (BW 125 kHz) | ≈ −123 dBm con SF7 · ≈ −129 dBm con SF9 · ≈ −137 dBm con SF12 |
| SNR mínimo para recibir | ≈ −7.5 dB con SF7 · ≈ −12.5 dB con SF9 · ≈ −20 dB con SF12 |
| Consumo | ~10–12 mA recibiendo · ~90–120 mA transmitiendo a 17 dBm |

La sección [7](#7-el-enlace-lora) explica cómo elegir los parámetros.

---

## 2. Las variables

Cada paquete del Nodo A produce **una fila en la bitácora** con estas columnas:

| Columna | Unidad | Origen | Qué significa |
|---|---|---|---|
| `t` | ms Unix | PC | Hora a la que la PC **recibió** el paquete |
| `seq` | — | Nodo A | Número de paquete; sube de 1 en 1 y vuelve a 1 si el Nodo A se reinicia |
| `rumbo` | ° (0–360) | BNO055 | Hacia dónde apunta el sensor respecto al norte magnético |
| `alabeo` | ° (±90) | BNO055 | Inclinación a los lados |
| `cabeceo` | ° (±180) | BNO055 | Inclinación adelante/atrás; ±180 = de cabeza |
| `wx, wy, wz` | °/s | BNO055 | Velocidad de giro alrededor de cada eje del sensor |
| `w_mag` | °/s | API | Magnitud total de giro, √(wx²+wy²+wz²) |
| `ax, ay, az` | m/s² | BNO055 | Aceleración lineal (sin gravedad) en cada eje |
| `a_mag` | m/s² | API | Magnitud de la aceleración lineal |
| `cal_sys … cal_mag` | 0–3 | BNO055 | Calibración del sistema, giroscopio, acelerómetro y magnetómetro |
| `qw, qx, qy, qz` | — | BNO055 | Cuaternión de orientación (para la vista 3D) |
| `temp` | °C | DHT11 | Temperatura del aire |
| `hum` | % | DHT11 | Humedad relativa |
| `gas_mv` | mV | MQ-2 | Voltaje de su salida AO (sube con gas o humo) |
| `uv_mv` | mV | UVM30A | Voltaje de su salida (sube con la radiación UV) |
| `uv` | índice | API | Índice UV calculado a partir de `uv_mv` |
| `lat, lon` | grados | GPS | Posición; vacía sin fix |
| `alt_gps` | m s. n. m. | GPS | Altitud sobre el nivel del mar |
| `sats` | — | GPS | Satélites en uso; vacío = no llega nada del GPS |
| `hdop` | — | GPS | Precisión horizontal: < 2 excelente, 2–5 buena, > 5 mala |
| `rssi` | dBm | Nodo B | Potencia con la que llegó la señal LoRa |
| `snr` | dB | Nodo B | Relación señal/ruido del paquete |
| `perdidos` | — | API | Cuántos paquetes faltaron justo antes de este |
| `crudo` | texto | Nodo B | La línea tal como llegó (para auditar) |

**Un campo vacío (`NULL`) significa "ese dato no estaba disponible"**, nunca "vale cero": el DHT11 falló esa vez, el GPS no tenía fix, o el firmware era de una versión sin ese sensor.

### Qué hacer con cada variable

**Orientación y giro (BNO055):**
- **Estabilidad del descenso:** con el paracaídas abierto, el alabeo y el cabeceo deberían oscilar poco. Oscilaciones grandes y regulares indican efecto péndulo; su período se mide en la gráfica.
- **Velocidad de rotación:** `w_mag` en °/s ÷ 6 = revoluciones por minuto. Un giro alto y constante sobre un eje indica que el paracaídas o el CanSat "trompea".
- **Eventos del vuelo** en `a_mag`:
  - **Liberación:** un pico de aceleración y de giro.
  - **Apertura del paracaídas:** un tirón fuerte.
  - **Aterrizaje:** un pico, y después `w_mag` cerca de 0 y orientación fija. El dashboard ya clasifica el estado en reposo, balanceo, girando o sacudida fuerte.
- **Orientación del UV (cuando lo agreguen):** saber hacia dónde apuntaba el sensor UV en cada lectura permite descartar las que no miraban al cielo.

**Temperatura y humedad (DHT11):**
- **Perfil vertical:** se grafica la temperatura contra `alt_gps` durante el descenso. En la atmósfera estándar la temperatura baja unos 6.5 °C por cada km.
- **Punto de rocío** (fórmula de Magnus):
  - `γ = ln(HR/100) + 17.62·T / (243.12 + T)`
  - `Td = 243.12·γ / (17.62 − γ)`
- **Condiciones de riesgo de incendio:** una regla práctica usada en el combate de incendios es la **"30-30-30"**: temperatura > 30 °C, humedad < 30 % y viento > 30 km/h. Las dos primeras las mide Pyro-SCOUT directamente. El viento se puede estimar con el GPS (abajo).

**Gas (MQ-2):**
- **Detectar humo o gases:** un aumento sostenido respecto a la línea base (por ejemplo, más de +20–30 % durante varios segundos) indica humo o gas.
- **Mapa de lecturas:** combinado con `lat`/`lon` se hace un mapa de dónde subió el gas.
- **Sin precalentar no sirve:** las lecturas de los primeros minutos tras encender no son confiables.

**Radiación UV (UVM30A):**
- **Índice UV durante el vuelo y en tierra:** con su categoría de la OMS.
- **Perfil vertical:** el UV aumenta con la altitud, aproximadamente un 10 % por cada km, porque hay menos atmósfera que lo filtre.
- **Validar la lectura con la orientación:** quedarse solo con las lecturas en las que el sensor miraba hacia arriba.
- **Riesgo de exposición:** con la tabla de categorías, como guía de protección solar para las personas en la zona.

**GPS:**
- **Trayectoria:** el recorrido completo ya se dibuja en el mapa.
- **Punto de aterrizaje:** la última posición, para **recuperar el CanSat** (botón "Abrir en Google Maps").
- **Velocidad de descenso:** la diferencia de `alt_gps` entre lecturas entre el tiempo entre ellas. Con paracaídas, un CanSat suele bajar entre 5 y 12 m/s, según el diseño.
- **Viento:** mientras cuelga del paracaídas, el CanSat viaja con el viento. Su velocidad horizontal (distancia entre posiciones ÷ tiempo) es una estimación del viento a esa altura.

**Enlace LoRa:**
- **Margen del enlace:** se compara el `rssi` contra la sensibilidad del perfil (−123 dBm en SF7). La diferencia es el margen que queda; conviene que sea de al menos 10 dB.
- **SNR:** si se acerca a −7.5 dB (en SF7), el enlace está al límite.
- **Paquetes perdidos:** `perdidos` y el porcentaje del dashboard dicen qué tan confiable fue el enlace.
- **Exportar:** todo se puede sacar en CSV ("Exportar CSV") para analizarlo en Excel, Python o MATLAB.

---

## 3. Conexiones y energía

### 3.1 Nodo A (Heltec WiFi LoRa 32 V2)

| Sensor | Pin del sensor | Pin del Heltec V2 |
|---|---|---|
| **BNO055** | VIN | 3V3 |
| | GND | GND |
| | SDA | GPIO 4 (compartido con la pantalla) |
| | SCL | GPIO 15 (compartido con la pantalla) |
| **DHT11** | VCC (+) | 3V3 |
| | GND (−) | GND |
| | DATA | GPIO 17 |
| **GPS NEO-6M** | VCC | 3V3 |
| | GND | GND |
| | TX | GPIO 23 (el ESP32 recibe por aquí) |
| | RX | GPIO 22 (opcional) |
| **MQ-2** | VCC | 5 V |
| | GND | GND |
| | AO | divisor → GPIO 36 |
| | DO | sin conectar |
| **UVM30A** | VCC (+) | 3V3 |
| | GND (−) | GND |
| | OUT (S) | GPIO 39, directo, sin divisor |
| **Botón** | un lado | GPIO 13 |
| | otro lado | GND |
| **LED** | ánodo | GPIO 25 (con su resistencia) |

**Divisor del MQ-2:** `AO —[10 kΩ]— GPIO 36 —[15 kΩ]— GND`. Si usan otras resistencias, cambien `MQ2_R_SUP` y `MQ2_R_INF` en el sketch.

**Pines ocupados por la placa (no usar):**

| Pines | Los usa |
|---|---|
| 5, 18, 19, 27 | SPI del LoRa |
| 14 | Reset del LoRa |
| 26 | DIO0 del LoRa |
| 34, 35 | DIO2 y DIO1 del LoRa |
| 4, 15 | I2C de la pantalla |
| 16 | Reset de la pantalla |
| 21 | Vext (alimentación de la pantalla) |
| 1, 3 | USB/serial |
| 0 | Botón PRG / arranque |

### 3.2 Nodo B (TTGO LoRa32 T3 V1.6.1)

No lleva sensores. Va conectado por USB a la PC (aparece como `/dev/ttyACM0`, con chip CH9102). Su pantalla usa I2C en los pines 21 y 22. El voltaje de la batería se lee en el GPIO 35, que es lo que hace el sketch `arduino/cargar_pila`.

### 3.3 Energía del Nodo A (aproximado)

| Consumidor | Corriente aproximada |
|---|---|
| ESP32 + radio recibiendo | 80–130 mA |
| Radio transmitiendo a 17 dBm | 90–120 mA durante ~0.25 s cada segundo (perfil rápido) |
| GPS buscando satélites | ~45 mA |
| BNO055 en NDOF | ~12 mA |
| Pantalla OLED | 10–20 mA |
| DHT11 | < 2.5 mA |
| UVM30A | < 1 mA |
| **MQ-2 (calentador, a 5 V)** | **~150 mA a 5 V ≈ 220–250 mA tomados de la LiPo a través de un elevador** |

**Total con MQ-2:** unos 400–500 mA de la batería. Con una LiPo de 1000 mAh serían **~2 horas**; menos si hace frío o la batería está gastada. Hay que medirlo con un multímetro antes del vuelo.

**El MQ-2 necesita 5 V reales.** El pin de 5 V del Heltec **solo tiene voltaje con USB conectado**. Con batería hace falta un **elevador de voltaje** (por ejemplo, un MT3608 ajustado a 5.0 V) para el MQ-2.

---

## 4. Los microcontroladores

| | Nodo A: Heltec WiFi LoRa 32 V2 | Nodo B: LilyGO TTGO T3 LoRa32 V1.6.1 |
|---|---|---|
| Procesador | ESP32 doble núcleo, 240 MHz | ESP32 doble núcleo, 240 MHz |
| Flash | **8 MB** | **4 MB** |
| Cristal | 40 MHz | 40 MHz |
| Radio | SX1276, 915 MHz | SX1276, 915 MHz |
| Pantalla | OLED 0.96" SSD1306 (I2C 4/15) | OLED 0.96" SSD1306 (I2C 21/22) |
| USB a serial | CP2102 (`/dev/ttyUSB*`) | CH9102 (`/dev/ttyACM0`) |
| Batería | Conector JST, carga LiPo | Conector JST, carga LiPo; voltaje en GPIO 35 |
| **Placa en el Arduino IDE** | **"Heltec WiFi LoRa 32(V2)"** | **"Heltec Wireless Stick Lite / Wireless Shell"** |

**Por qué el Nodo B se programa como "Wireless Stick Lite":** el core de Heltec instalado no trae una opción para el TTGO.
- **"Heltec WiFi LoRa 32(V2)" no sirve:** asume 8 MB de flash y el TTGO, que tiene 4 MB, se reinicia en bucle.
- **"Heltec WiFi LoRa 32" (V1) y "WiFi Kit 32" no sirven:** fuerzan un cristal de 26 MHz y el puerto serial sale como basura.
- **"Wireless Stick Lite" coincide:** 4 MB y cristal de 40 MHz, igual que el TTGO. El sketch define todos sus pines a mano, así que la variante de la placa no afecta.

---

## 5. Firmware del Nodo A

Archivo: `arduino/nodoA_heltec/nodoA_heltec.ino`.

### 5.1 Librerías

| Librería (Gestor de librerías del Arduino IDE) | Para qué |
|---|---|
| LoRa (Sandeep Mistry) | Radio SX1276 |
| Adafruit BNO055 + Adafruit Unified Sensor | BNO055 |
| (ninguna) | UVM30A: es una lectura analógica directa |
| ESP8266 and ESP32 OLED driver for SSD1306 (ThingPulse) | Pantalla |
| DHT sensor library (Adafruit) | DHT11 |
| TinyGPSPlus (Mikal Hart) | Interpretar las frases NMEA del GPS |
| Preferences (ya viene con el ESP32) | Guardar la calibración en la memoria flash |

### 5.2 Ciclo de trabajo

- **`setup()`:**
  - Enciende la pantalla e inicia el BNO055 en NDOF con reloj interno.
  - Carga la calibración guardada, si existe, e inicia el DHT11, el ADC del MQ-2 y el UART del GPS (con un buffer de 2 KB).
  - Configura el radio según `PERFIL_RADIO` y manda `INFO,Nodo A iniciado…`.
- **`loop()`:**
  1. Entrega al parser del GPS todo lo que haya llegado por el UART.
  2. Revisa el botón: una pulsación corta envía una lectura en ese momento; mantenerlo **3 s** borra la calibración guardada.
  3. Cada `SEND_INTERVAL_MS` (1 s en el perfil rápido) ejecuta `leerYEnviar()`.
  4. Escucha la radio:
     - **`ACK,<seq>`:** el LED parpadea (el Nodo B recibió el paquete).
     - **`REQ_B`:** envía una lectura inmediata.
- **`leerYEnviar()`:**
  - Lee el BNO055 (Euler, giroscopio, aceleración lineal, cuaternión y calibración), el DHT11, el MQ-2 y el UVM30A (promedio de 16 lecturas cada uno) y el último dato del GPS.
  - Arma el paquete y lo transmite **de forma bloqueante**. En modo asíncrono, el `parsePacket()` del loop cambia el radio a recepción y puede cortar la transmisión a la mitad.
  - Actualiza la pantalla y, si la calibración está completa, la guarda.

### 5.3 El paquete

```
B,seq,rumbo,alabeo,cabeceo,wx,wy,wz,ax,ay,az,cal,temp,hum,gas,lat,lon,alt,sats,hdop,qw,qx,qy,qz,uv
B,42,187.3,-2.1,4.6,0.3,-1.2,15.8,0.04,-0.11,0.20,3323,27,61,1180,24.14263,-110.31280,25,7,1.2,0.7071,0.0012,-0.0003,0.7071,606
```

**Formato:**
- **Texto separado por comas:** 25 campos que se pueden leer a simple vista en el Monitor Serie. Mide de 90 a 150 bytes.
- **Campos vacíos:** son datos no disponibles.
- **Calibración:** cuatro dígitos `SGAM` (sistema, giroscopio, acelerómetro, magnetómetro).
- **Decimales:** se recortan para ahorrar tiempo en el aire. Los ángulos y el giro van con 1 decimal, la aceleración con 2, el GPS con 5 (≈1 m) y el cuaternión con 4.
- **Mensajes `INFO,<texto>`:** el Nodo A los manda al arrancar y al guardar o borrar la calibración. La API los guarda como eventos `nodo_a`.

### 5.4 Calibración del BNO055

**Cómo funciona:**
- El BNO055 recalibra **solo, todo el tiempo**, mientras está en NDOF. No hay que apretar nada; solo darle el movimiento que necesita cada sensor.
- Cada sensor reporta 0–3; el **sistema (S)** sube solo cuando los demás están bien.

| Sensor | Qué hacer | Tiempo típico |
|---|---|---|
| Giroscopio (G) | Dejarlo **completamente quieto** sobre la mesa | 2–5 s |
| Acelerómetro (A) | Ponerlo **quieto 2–3 s en 6 posiciones** (boca arriba, boca abajo y los 4 lados, como las caras de un dado), moviéndolo despacio entre una y otra | 30–60 s |
| Magnetómetro (M) | En la mano, **lejos de metal y aparatos**, dibujar **ochos grandes** en el aire girándolo en todos los sentidos | 10–30 s |
| Sistema (S) | Automático cuando los otros tres van bien | — |

**Por qué "no hacía nada" antes:**
1. **Se pierde al apagar.** El BNO055 no guarda su calibración. Ahora el Nodo A la guarda en su memoria flash (`Preferences`) la primera vez que llega a 3·3·3·3 y la **restaura al encender**. Aun así, los números arrancan bajos y suben en segundos con un poco de movimiento, porque el chip confirma la calibración antes de reportarla.
2. **Interferencia magnética.** Laptops, mesas o patas metálicas, imanes, bocinas, el cable USB, la batería LiPo y el elevador desvían el magnetómetro. Si cerca de algo baja a 0–1, es el entorno, no una falla.
3. **Movimiento incorrecto.** El acelerómetro no se calibra moviéndolo sin parar: necesita **posiciones quietas distintas**.
4. **Antes se veía cada 10 s.** Con el perfil rápido (un paquete por segundo) el avance se ve casi en tiempo real en la guía del dashboard.

**Borrar una calibración mala:** mantener el botón del Nodo A **3 segundos**. La pantalla muestra "Calibración borrada".

---

## 6. Firmware del Nodo B

Archivo: `arduino/nodoB_ttgo/nodoB_ttgo.ino`.

- **Recibe y reenvía:** recibe cada paquete LoRa y lo escribe por USB, a 115200 baudios, como una sola línea:
  ```
  RX,<rssi>,<snr>,<paquete>
  RX,-61,7.5,B,22,336.9,-7.5,-177.1,...
  ```
- **ACK:** a cada paquete de datos responde `ACK,<seq>` por LoRa, de inmediato, porque el Nodo A ya está escuchando.
- **Mensajes informativos:** escribe líneas que empiezan con `#`, por ejemplo `# Nodo B listo, perfil 1 (SF7)`.
- **Comando `REQ`:** si la PC le escribe `REQ` (botón 📡 del dashboard), o si se aprieta su botón, manda `REQ_B` al Nodo A para pedir una lectura inmediata.
- **Pantalla:** muestra la secuencia, la orientación, la temperatura, la humedad, el GPS y RSSI/SNR.
- **I2C a 400 kHz:** en este nodo la pantalla es lo único en el bus, y así se refresca 4 veces más rápido.

---

## 7. El enlace LoRa

### 7.1 Parámetros

| Parámetro | Valor | Qué controla |
|---|---|---|
| Frecuencia | 915 MHz | Banda ISM de 902–928 MHz |
| Ancho de banda (BW) | 125 kHz | Más ancho = más rápido, menos alcance |
| Factor de dispersión (SF) | según el perfil | Cada +1 duplica el tiempo en el aire y da ~+2.5 dB de sensibilidad |
| Codificación (CR) | 4/5 o 4/8 | Redundancia contra errores; 4/8 tarda ~60 % más que 4/5 |
| Preámbulo | 8 símbolos | |
| Sync word | `0x12` | Red privada: ignora otras redes LoRa |
| CRC | activado | Descarta paquetes corruptos |
| Potencia | 17 dBm | |

**Los parámetros deben ser iguales en los dos nodos.** Si no, no se oyen.

### 7.2 Perfiles

Se elige con `#define PERFIL_RADIO`, que debe tener **el mismo número en el Nodo A y en el Nodo B**.

| Perfil | SF / CR | Tiempo en el aire (paquete completo) | Envío | Alcance relativo |
|---|---|---|---|---|
| **1 · RÁPIDO** (por defecto) | SF7 / 4/5 | ~0.25 s | cada 1 s | base |
| 2 · EQUILIBRADO | SF9 / 4/5 | ~0.75 s | cada 2 s | ≈ 1.8× |
| 3 · ALCANCE | SF12 / 4/8 | ~8 s | cada 15 s | ≈ 3–4× |

**Cómo elegir:**
- **Alcance real:** con línea de vista y antenas de serie, SF7 suele alcanzar de 1 a varios km. Un CanSat a unos cientos de metros de altura casi siempre tiene línea de vista.
- **Qué vigilar:** si en las pruebas de distancia el RSSI se acerca a −120 dBm o se pierden muchos paquetes, cambien al perfil 2.
- **Antenas:** verticales, lejos de metal y del cuerpo.
- **Regulación:** algunas normas de la banda de 915 MHz limitan cuánto tiempo seguido puede transmitir un equipo en un canal (en EE. UU., 400 ms). El perfil rápido (0.25 s) está dentro; el perfil 3 (8 s) no. Revisen la norma vigente del IFT para su caso.

### 7.3 Tiempo en el aire

Fórmula de Semtech (AN1200.13), con `Tsím = 2^SF / BW`:

```
símbolos = 8 + max(ceil((8·bytes − 4·SF + 28 + 16) / (4·(SF − 2·DE))) · (CR + 4), 0)
tiempo   = (preámbulo + 4.25 + símbolos) · Tsím
```

`DE = 1` solo con SF11–12 a 125 kHz. Con 140 bytes en SF7 da ~0.24 s; con SF12 y CR 4/8, ~8 s.

---

## 8. La API en Python

Archivos: `api/pyroscout_api.py` (servidor y lectura del puerto) y `api/bitacora.py` (SQLite). Usa FastAPI, uvicorn y pyserial (`api/requirements.txt`).

### 8.1 Cómo funciona

- **Hilo del puerto serial:**
  - Abre **solo** `/dev/ttyACM0` (constante `PUERTO_NODO_B`). Si no existe o no tiene permiso, reintenta cada 2 s y lo avisa en el dashboard.
  - Acumula bytes hasta cada salto de línea, en lugar de usar `readline()` con timeout, que devolvía medias líneas.
  - Interpreta cada línea:
    - `RX,…,B,…`: lectura.
    - `RX,…,INFO,…`: evento `nodo_a`.
    - `# …`: evento `nodo_b`.
    - Cualquier otra cosa: evento `serial`.
- **Validación:**
  - Revisa el número de campos (12, 20, 24 o 25), los rangos (por ejemplo, humedad de 0 a 100) y la coherencia (no puede haber latitud sin longitud).
  - Normaliza el cuaternión y lo descarta si viene en cero.
  - Lo que no pasa se guarda como evento `invalido`, nunca como lectura.
- **Cálculos:** `w_mag`, `a_mag`, el índice UV y los paquetes perdidos (huecos en `seq`). También detecta reinicios del Nodo A (cuando la secuencia retrocede) y paquetes duplicados.
- **Transmisión en vivo:** cada lectura se guarda en SQLite y se manda al dashboard por **Server-Sent Events** (SSE) en `/api/stream`.
- **Compatibilidad:** acepta el formato `G` del firmware original (solo toma su giroscopio y le corrige el ×57.3) y los paquetes `B` de 12, 20 y 24 campos.

### 8.2 Bitácora SQLite (`data/bitacora.db`)

| Tabla | Contenido |
|---|---|
| `sesiones` | Cada prueba o lanzamiento: nombre, inicio y fin |
| `lecturas` | Una fila por paquete, con las columnas de la [sección 2](#2-las-variables) |
| `eventos` | Conexiones, desconexiones, paquetes perdidos, inválidos o duplicados, reinicios, mensajes de los nodos y solicitudes |

- **Nunca se borra nada desde el dashboard.** "Nueva sesión" cierra la sesión actual y abre otra.
- **Al iniciar, la API agrega sola las columnas nuevas** a una bitácora vieja (migración), sin borrar datos.
- **Modo WAL:** se puede leer la base mientras la API escribe.

### 8.3 Endpoints

| Endpoint | Para qué |
|---|---|
| `GET /api/estado` | Puerto, sesión actual y conteos |
| `GET /api/historial?n=600` | Últimas lecturas de la sesión actual (para las gráficas) |
| `GET /api/stream` | Lecturas, eventos y estado en vivo (SSE) |
| `POST /api/solicitar` | Pide una lectura inmediata al Nodo A |
| `GET /api/sesiones` · `POST /api/sesiones` | Lista o crea sesiones |
| `GET /api/bitacora?sesion=&pagina=&limite=` | Lecturas paginadas |
| `GET /api/bitacora/eventos?sesion=` | Eventos de una sesión |
| `GET /api/bitacora.csv?sesion=` | Exporta una sesión a CSV |

La documentación interactiva está en `http://localhost:8000/docs`.

---

## 9. El dashboard

Archivos: `public/index.html`, `public/app.js` y `public/style.css`, servidos por `server.js` (Node.js sin dependencias, puerto 3000).

### 9.1 Librerías externas

Se cargan de internet: **Chart.js 4.4.1** (gráficas), **Leaflet 1.9.4** con mapas de **OpenStreetMap** y las fuentes Space Grotesk e Inter de Google Fonts.
- **Sin internet:** el mapa no se dibuja, pero las coordenadas siguen visibles. Las gráficas también necesitan Chart.js.
- **Si el campo no tiene internet:** abran el dashboard una vez con conexión, o guarden esas librerías en `public/`.

### 9.2 Secciones

| Sección | Qué muestra |
|---|---|
| **Inicio** | Vista 3D con los ejes del sensor, estado de movimiento, enlace, calibración, GPS, ficha PS-01, brújula, horizonte artificial y barras por eje |
| **Movimiento** | Indicadores del BNO055, **guía de calibración paso a paso** y gráficas de orientación, giro, aceleración y enlace |
| **Ambiente y GPS** | Temperatura, humedad, gas, índice UV, altitud, satélites, mapa del recorrido y gráficas |
| **Bitácora** | Tabla paginada de la base, eventos, selector de sesión, "Nueva sesión" y "Exportar CSV" |

### 9.3 Cómo se mueven los datos dentro del navegador

1. **Al abrir:** `EventSource('/api/stream')` se conecta a la API. Al conectar (y al reconectar) pide `/api/historial` para no perder lo que llegó mientras estaba desconectado.
2. **Cada lectura** se agrega a `historial`, que guarda las últimas 600, unos 10 min a 1 Hz. Se redibuja todo una sola vez por cuadro de animación (`requestAnimationFrame`).
3. **"En vivo"** se calcula con el intervalo real entre paquetes (la mediana de los últimos 20). Si pasan más de 3 intervalos (mínimo 3 s) sin datos, el indicador dice "Sin señal LoRa".
4. **La tabla de la bitácora** se recarga sola si estás viendo la primera página de la sesión actual.

### 9.4 La vista 3D con ejes X/Y/Z

- **Qué dibuja** (en un `<canvas>`, sin librerías 3D):
  - **Ejes de referencia** fijos y punteados (X₀, Y₀, Z₀).
  - Una **esfera de alambre** pegada al sensor que gira con él.
  - Los **ejes X (rojo), Y (verde) y Z (azul) del sensor.**
  - El **vector de velocidad angular ω (amarillo)**: apunta en el eje alrededor del cual está girando, con un largo proporcional a la velocidad.
- **Cómo gira:** usa el **cuaternión** del BNO055. Cada eje del sensor se transforma con la matriz de rotación que sale del cuaternión, `v_ref = R(q) · v_sensor`. Si el firmware no manda cuaternión, lo arma con los ángulos de Euler.
- **Movimiento suave:** entre un paquete y el siguiente interpola con *slerp* (interpolación esférica de cuaterniones).
- **Controles:** arrastrar con el mouse gira la vista; doble clic vuelve a la vista inicial.

### 9.5 Indicadores derivados

| Indicador | Cómo se calcula |
|---|---|
| Estado de movimiento | `a_mag > 15` → sacudida fuerte; `w_mag < 3` y `a_mag < 0.5` → en reposo; `w_mag < 30` → balanceo; si no, girando |
| Gas "% vs primeras lecturas" | Cambio respecto al promedio de las primeras 6 lecturas que se están mostrando |
| Paquetes perdidos | Suma de huecos en `seq` dentro de la sesión |

---

## 10. Operación

### 10.1 Instalación (una sola vez)

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

**Permisos del puerto en Linux:** tu usuario debe estar en el grupo `dialout`:
```bash
sudo usermod -aG dialout $USER
```
Después cierra sesión y vuelve a entrar; `groups` debe mostrar `dialout`.

**Arduino IDE:** instala las librerías de [5.1](#51-librerías) y el core "Heltec ESP32".

### 10.2 Cargar el firmware

1. **Nodo A:** placa **"Heltec WiFi LoRa 32(V2)"** → `arduino/nodoA_heltec`.
2. **Nodo B:** placa **"Heltec Wireless Stick Lite / Wireless Shell"** → `arduino/nodoB_ttgo`.
3. **Perfil de radio:** confirma que `PERFIL_RADIO` sea el mismo en los dos.

### 10.3 Arrancar la estación terrena

1. Conecta el Nodo B por USB y **cierra el Monitor Serie del Arduino IDE**. Solo un programa puede abrir el puerto a la vez.
2. Inicia la API:
```bash
api/.venv/bin/python api/pyroscout_api.py
```
3. Inicia el dashboard en otra terminal:
```bash
npm start
```
4. Abre `http://localhost:3000` y crea una **Nueva sesión** con el nombre de la prueba.

### 10.4 Lista previa al vuelo

- [ ] **Batería:** cargada; medir el voltaje con `arduino/cargar_pila` o un multímetro.
- [ ] **MQ-2:** encendido **al menos 2–3 minutos** antes (precalentamiento) y con el elevador a 5 V.
- [ ] **UVM30A:** descubierto (sin vidrio ni acrílico encima) y del lado del CanSat que mirará al cielo.
- [ ] **GPS:** con fix (LED parpadeando, `sats` ≥ 4, `hdop` < 5) antes de cerrar el CanSat.
- [ ] **BNO055:** calibración 3·3·3·3 (o restaurada) y rumbo coherente con una brújula.
- [ ] **Enlace:** "En vivo" en el dashboard, RSSI razonable y 0 % de paquetes perdidos a corta distancia.
- [ ] **Prueba de distancia:** hecha con el perfil elegido, a la distancia esperada del vuelo.
- [ ] **Sesión:** nueva sesión creada con nombre ("Lanzamiento 1").
- [ ] **Montaje:** antena vertical, GPS hacia arriba, DHT11 y MQ-2 con aire circulando, nada suelto.
- [ ] **Después del vuelo:** exportar el CSV y respaldar `data/bitacora.db`.

---

## 11. Solución de problemas

### 11.1 El dashboard dice "API Python apagada"
La API no está corriendo, o corre en otra computadora. Iníciala; si está en otra PC, abre `http://localhost:3000/?api=http://IP-de-esa-PC:8000`.

### 11.2 "Sin permiso para abrir /dev/ttyACM0"
Tu usuario no está en el grupo `dialout`. Ver [10.1](#101-instalación-una-sola-vez).

### 11.3 "Device or resource busy"
Otro programa tiene el puerto abierto, normalmente el Monitor Serie del Arduino IDE, u otra API corriendo. Ciérralo.

### 11.4 El Nodo B se reinicia en bucle o manda basura
Se subió con la placa equivocada. Ver [4](#4-los-microcontroladores).
- **Reinicio en bucle con `Detected size(4096k) smaller than … (8192k)`:** se subió como "Heltec WiFi LoRa 32(V2)".
- **Caracteres ilegibles (`�…`) a 115200:** se subió como "Heltec WiFi LoRa 32" (V1), que fuerza el cristal de 26 MHz.

### 11.5 BNO055 entrega todo en 0
- **Todo en 0, incluso la calibración, y el sketch de diagnóstico da `estado 0 (inactivo)` en NDOF:** se está usando el cristal externo. Debe ser `setExtCrystalUse(false)`.
- **Todo en 0 al moverlo:** revisa VIN, GND, SDA y SCL; un falso contacto resetea el chip, y tras un reset se queda en modo configuración (todo en 0).
- **Herramienta:** el sketch `arduino/diagnostico_bno055` muestra el autotest, el modo y los datos crudos.

### 11.6 El gas siempre marca 0
El MQ-2 está en un pin ocupado (GPIO 34 = DIO2 del LoRa), falta el divisor o no tiene 5 V. Debe ir en el GPIO 36 con el divisor.

### 11.7 El UV siempre marca 0 o casi 0
En interiores es normal: el vidrio de las ventanas bloquea casi todo el UV. Pruébalo al sol directo. Si al sol sigue en 0, revisa que OUT vaya al GPIO 39 y que el módulo tenga 3.3 V.

### 11.8 El GPS no da posición
- **`sats` = 0:** el GPS está conectado pero sin satélites. Sal a cielo abierto y espera (la primera vez, hasta 15 min).
- **`sats` vacío:** no llega nada. Revisa que el TX del GPS vaya al GPIO 23 y que tenga 3.3 V.

### 11.9 El DHT11 da "--"
Falla la lectura: cableado, falta la resistencia *pull-up* o el sensor está fuera de rango (por debajo de 0 °C o por encima de 50 °C).

### 11.10 El dashboard no muestra datos nuevos o se ve la versión vieja
Recarga forzando con **Ctrl+Shift+R**. `server.js` ya manda `Cache-Control: no-cache`, así que esto solo pasa con pestañas abiertas antes de una actualización.

### 11.11 `npm start` dice que el puerto 3000 está en uso
Ya hay otro `npm start` abierto. Ciérralo, o usa otro puerto: `PORT=3001 npm start`.

### 11.12 `DHT.h: No such file or directory` al compilar
Falta instalar "DHT sensor library" (Adafruit). Lo mismo con `TinyGPS++.h`: falta "TinyGPSPlus" (Mikal Hart).

### 11.13 El Nodo A no se comunica con el Nodo B
Revisa que tengan el mismo `PERFIL_RADIO`, la misma frecuencia y el mismo sync word, y que las antenas estén conectadas. **Nunca transmitas sin antena:** puede dañar el radio.

---

## 12. Visión general

```
                 CanSat Pyro-SCOUT                                   Estación terrena (PC)
┌───────────────────────────────────────────┐            ┌──────────────────────────────────────────────┐
│ BNO055 ─┐                                 │            │                                              │
│ DHT11  ─┤                                 │  LoRa      │  Nodo B (TTGO) ──USB──► API Python (:8000)   │
│ MQ-2   ─┤                                 │            │                                              │
│ UVM30A ─┼─► Nodo A (Heltec V2, ESP32) ────┼─ 915 MHz ─►│   RX,rssi,snr,…        · valida y calcula    │
│ GPS    ─┘    arma el paquete 1 vez/s      │ ◄── ACK ───│   ◄── REQ ──            · bitácora SQLite     │
│              guarda la calibración        │            │                         · SSE + REST          │
└───────────────────────────────────────────┘            │                              │                │
                                                         │  Navegador ◄── HTML ── Node (:3000)          │
                                                         │   dashboard: 3D, gráficas, mapa, bitácora    │
                                                         └──────────────────────────────────────────────┘
```

**Flujo completo de un dato:**
1. El sensor mide.
2. El Nodo A lo lee y lo mete en el paquete de texto.
3. El paquete viaja por LoRa (~0.25 s).
4. El Nodo B lo recibe, agrega RSSI y SNR, y lo escribe por USB.
5. La API lo valida, calcula los valores derivados y lo guarda en SQLite.
6. La API lo empuja al navegador por SSE.
7. El dashboard actualiza los indicadores, las gráficas, la vista 3D y el mapa.

**Para qué sirve en la misión:** Pyro-SCOUT reúne, en un mismo instante y lugar, **condiciones del aire** (temperatura, humedad, gases o humo y radiación UV), **posición** (GPS) y **comportamiento del vehículo** (orientación, giro y aceleración). Con eso se puede:
- Construir perfiles verticales de temperatura y humedad durante el descenso.
- Detectar y ubicar en el mapa aumentos de gas o humo.
- Medir el índice UV y cómo cambia con la altitud.
- Evaluar condiciones favorables a incendios: temperatura alta y humedad baja, con el viento estimado por la deriva del GPS.
- Reconstruir el vuelo: liberación, apertura del paracaídas, estabilidad, velocidad de descenso y aterrizaje.
- Recuperar el CanSat con su última posición.
- Medir la calidad del enlace de comunicaciones.

**Mejoras naturales:**
- **Validar el UV con la orientación del BNO055** directamente en el dashboard, marcando las lecturas en las que el sensor no miraba al cielo.
- **Barómetro BMP280/BME280:** altitud mucho más precisa que la del GPS para la velocidad de descenso.
- **DHT22 o SHT31** en lugar del DHT11, por el rango de temperatura.
- **Calibración del MQ-2 en aire limpio** (Ro) para estimar ppm.
- **Copia de los datos en una microSD** en el Nodo A, por si se pierde el enlace.
- **Añadir a `.gitignore`** la base de datos (`data/*.db*`) y `__pycache__/`, para que no se suban al repositorio en cada commit.

---

## 13. Glosario

| Término | Significado |
|---|---|
| **Alabeo (roll)** | Giro sobre el eje longitudinal; inclinación hacia los lados |
| **Cabeceo (pitch)** | Inclinación hacia adelante o atrás |
| **Rumbo (heading / yaw)** | Hacia dónde apunta, respecto al norte magnético |
| **Cuaternión** | Cuatro números (w, x, y, z) que describen una orientación sin las ambigüedades de los ángulos de Euler |
| **Fusión de sensores** | Combinar acelerómetro, giroscopio y magnetómetro para obtener una orientación estable |
| **NDOF** | Modo de fusión de 9 ejes del BNO055 |
| **Fix (GPS)** | Cuando el GPS ya calculó su posición |
| **HDOP** | Factor de precisión horizontal del GPS; menor es mejor |
| **NMEA** | Formato de texto en que hablan los GPS |
| **RSSI** | Potencia de la señal recibida (dBm); más cerca de 0 es más fuerte |
| **SNR** | Relación señal/ruido (dB) |
| **SF** | Factor de dispersión LoRa: más alto = más alcance y más lento |
| **Tiempo en el aire** | Lo que tarda un paquete en transmitirse |
| **ACK** | Confirmación de recepción |
| **SSE** | Server-Sent Events: el servidor empuja datos al navegador por una conexión abierta |
| **WAL** | Modo de SQLite que permite leer mientras se escribe |
| **Ro / Rs** | Resistencia del MQ-2 en aire limpio / medida |
| **Divisor de voltaje** | Dos resistencias que bajan un voltaje en una proporción fija |
| **Índice UV** | Escala de la OMS para la intensidad de la radiación ultravioleta que quema la piel (0 a 11+) |
