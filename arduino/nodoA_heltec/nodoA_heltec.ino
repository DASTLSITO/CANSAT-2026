// ============================================================
//  COSTA · Nodo A (Heltec WiFi LoRa 32 V2) — va dentro del CanSat
//  Lee el BNO055 (orientación y movimiento), el DHT11 (temperatura y
//  humedad), el MQ-2 (gases) y el GPS NEO-6M (GY-GPS6MV2), y lo
//  transmite todo por LoRa al Nodo B.
//
//  Paquete (texto, campos vacíos = dato no disponible):
//    B,seq,rumbo,alabeo,cabeceo,wx,wy,wz,ax,ay,az,cal,temp,hum,gas,lat,lon,alt,sats,hdop
//      rumbo/alabeo/cabeceo  -> grados (Euler del BNO055)
//      wx,wy,wz              -> °/s (giroscopio)
//      ax,ay,az              -> m/s² (aceleración lineal, sin gravedad)
//      cal                   -> 4 dígitos SGAM (sistema, giro, acel, mag), 0..3
//      temp, hum             -> °C y % (DHT11, enteros)
//      gas                   -> mV en la salida AO del MQ-2 (ya corregido por el divisor)
//      lat, lon              -> grados decimales (vacíos si el GPS no tiene fix)
//      alt                   -> m sobre el nivel del mar (GPS)
//      sats, hdop            -> satélites en uso y precisión horizontal (menor = mejor)
//  Ejemplo: B,42,187.3,-2.1,4.6,0.3,-1.2,15.8,0.04,-0.11,0.20,3323,27,61,1180,24.14263,-110.31280,25,7,1.2
//
//  ---- Conexiones (Heltec V2) ----
//    BNO055   VIN -> 3V3   GND -> GND   SDA -> GPIO 4   SCL -> GPIO 15
//    DHT11    VCC -> 3V3   GND -> GND   DATA -> GPIO 17  (10 kΩ de DATA a 3V3 si el sensor no es módulo)
//    GPS      VCC -> 3V3   GND -> GND   TX -> GPIO 23    RX -> GPIO 22
//    MQ-2     VCC -> 5 V   GND -> GND   AO -> divisor -> GPIO 36
//             divisor: AO --[10 kΩ]-- GPIO 36 --[15 kΩ]-- GND   (la salida de 5 V baja a ~3 V)
//
//  Placa en Arduino IDE: "Heltec WiFi LoRa 32(V2)"
//  Librerías: LoRa (Sandeep Mistry), Adafruit BNO055, Adafruit Unified Sensor,
//  ESP8266 and ESP32 OLED driver for SSD1306 (ThingPulse),
//  DHT sensor library (Adafruit), TinyGPSPlus (Mikal Hart)
// ============================================================
#include <SPI.h>
#include <LoRa.h>
#include <Wire.h>
#include "SSD1306.h"
#include <Adafruit_BNO055.h>
#include <Adafruit_Sensor.h>
#include <utility/imumaths.h>
#include <DHT.h>
#include <TinyGPS++.h>        // librería "TinyGPSPlus" de Mikal Hart

// ===== Heltec V2 LoRa (integrado) =====
#define SCK   5
#define MISO  19
#define MOSI  27
#define SS    18
#define RST   14
#define DIO0  26
#define BAND  915E6

// ===== OLED Heltec V2 =====
#define OLED_ADDR 0x3C
#define OLED_SDA  4
#define OLED_SCL  15
#define OLED_RST  16
#define VEXT_PIN  21

// ===== Botón / LED =====
#define BTN_PIN      13
#define LED_CONFIRM  25

// ===== Sensores ambientales y GPS =====
#define DHT_PIN       17
#define DHT_TIPO      DHT11
#define MQ2_PIN       36          // ADC1, solo entrada
#define MQ2_R_SUP     10000.0f    // resistencia entre AO del MQ-2 y el GPIO 36
#define MQ2_R_INF     15000.0f    // resistencia entre el GPIO 36 y GND
#define GPS_RX_PIN    23          // recibe lo que transmite el GPS (su pin TX)
#define GPS_TX_PIN    22          // va al pin RX del GPS (opcional)
#define GPS_BAUDIOS   9600        // velocidad de fábrica del NEO-6M
#define GPS_VIGENCIA  5000        // ms: más viejo que esto se considera sin fix

// ===== Parámetros LoRa (IGUALES en A y B) =====
#define TX_POWER_DBM   17
#define LORA_SF        12
#define LORA_BW        125E3
#define LORA_SYNCWORD  0x12
#define LORA_PREAMBLE  8

// ===== Intervalo de envío periódico =====
// Con SF12 y CR 4/8 el paquete completo (~100 bytes) tarda ~6 s en el aire;
// no bajes de 10 s o el radio pasará todo el tiempo transmitiendo.
#define SEND_INTERVAL_MS  10000UL

Adafruit_BNO055 bno(55, 0x28);           // dirección I2C por defecto
SSD1306 display(OLED_ADDR, OLED_SDA, OLED_SCL);
DHT dht(DHT_PIN, DHT_TIPO);
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);

uint32_t seq = 1;
unsigned long lastSend = 0;

void vextON() {
  pinMode(VEXT_PIN, OUTPUT);
  digitalWrite(VEXT_PIN, LOW);           // LOW = OLED encendida
}

void oledShow(String l1, String l2="", String l3="", String l4="") {
  display.clear();
  display.setFont(ArialMT_Plain_10);
  display.setTextAlignment(TEXT_ALIGN_LEFT);
  int y = 0;
  if (l1 != "") display.drawString(0, y, l1);
  y += 14;
  if (l2 != "") display.drawString(0, y, l2);
  y += 14;
  if (l3 != "") display.drawString(0, y, l3);
  y += 14;
  if (l4 != "") display.drawString(0, y, l4);
  display.display();
}

// Entrega al parser todo lo que haya mandado el GPS
void leerGPS() {
  while (gpsSerial.available()) gps.encode(gpsSerial.read());
}

// Voltaje (mV) en la salida AO del MQ-2, deshaciendo el divisor
int leerMQ2() {
  uint32_t suma = 0;
  for (int i = 0; i < 16; i++) suma += analogReadMilliVolts(MQ2_PIN);
  float mvPin = suma / 16.0f;
  return (int)(mvPin * (MQ2_R_SUP + MQ2_R_INF) / MQ2_R_INF + 0.5f);
}

// Agrega ",<valor>" al paquete, o solo "," si el dato no es válido
int agregar(char* p, size_t libre, bool valido, const char* fmt, double v) {
  return valido ? snprintf(p, libre, fmt, v) : snprintf(p, libre, ",");
}

void setup() {
  Serial.begin(115200);
  Serial.println("Nodo A (Heltec V2) iniciando...");

  pinMode(LED_CONFIRM, OUTPUT);
  digitalWrite(LED_CONFIRM, LOW);
  pinMode(BTN_PIN, INPUT_PULLUP);

  // ---- OLED ----
  vextON();
  delay(50);
  pinMode(OLED_RST, OUTPUT);
  digitalWrite(OLED_RST, LOW);
  delay(20);
  digitalWrite(OLED_RST, HIGH);
  delay(20);
  Wire.begin(OLED_SDA, OLED_SCL);
  Wire.setClock(100000);
  display.init();
  display.flipScreenVertically();
  oledShow("Nodo A (Heltec)", "Iniciando...", "", "");

  // ---- BNO055 (mismo bus I2C que OLED) ----
  if (!bno.begin(OPERATION_MODE_NDOF)) {   // NDOF = fusión acel + giro + magnetómetro
    oledShow("Error BNO055", "I2C 0x28", "Revisa cableado", "");
    Serial.println("BNO055 no encontrado");
    while (1) delay(1000);
  }
  delay(500);
  // Reloj INTERNO del BNO055. Con setExtCrystalUse(true) y un módulo sin cristal de
  // 32.768 kHz funcional, el modo NDOF se congela y todas las lecturas salen en 0
  // (los modos sin fusión, como GYRONLY o AMG, sí siguen funcionando).
  bno.setExtCrystalUse(false);

  // ---- DHT11, MQ-2 y GPS ----
  dht.begin();
  analogReadResolution(12);
  analogSetPinAttenuation(MQ2_PIN, ADC_11db);        // rango de lectura hasta ~3.1 V
  gpsSerial.setRxBufferSize(2048);                   // aguanta el GPS mientras LoRa transmite
  gpsSerial.begin(GPS_BAUDIOS, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  // ---- LoRa ----
  SPI.begin(SCK, MISO, MOSI);
  LoRa.setPins(SS, RST, DIO0);
  if (!LoRa.begin(BAND)) {
    oledShow("Error LoRa", "Revisa módulo", "", "");
    Serial.println("LoRa no inicia");
    while (1) delay(1000);
  }
  LoRa.setTxPower(TX_POWER_DBM);
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW);
  LoRa.setPreambleLength(LORA_PREAMBLE);
  LoRa.setSyncWord(LORA_SYNCWORD);
  LoRa.setCodingRate4(8);        // máxima robustez
  LoRa.enableCrc();

  oledShow("Nodo A listo",
           "Envío cada " + String(SEND_INTERVAL_MS / 1000) + " s",
           "o pulsa botón", "MQ-2 calienta ~2 min");
  lastSend = millis();
}

// Lee todos los sensores y transmite
void leerYEnviar() {
  leerGPS();

  // ---- BNO055 ----
  // Orientación absoluta (grados): x = rumbo, y = alabeo, z = cabeceo
  imu::Vector<3> e = bno.getVector(Adafruit_BNO055::VECTOR_EULER);
  // Giroscopio: getVector() ya entrega °/s (no hace falta convertir)
  imu::Vector<3> g = bno.getVector(Adafruit_BNO055::VECTOR_GYROSCOPE);
  // Aceleración lineal (m/s², gravedad ya descontada)
  imu::Vector<3> a = bno.getVector(Adafruit_BNO055::VECTOR_LINEARACCEL);
  // Calibración 0..3 (3 = calibrado)
  uint8_t cs, cg, ca, cm;
  bno.getCalibration(&cs, &cg, &ca, &cm);

  // ---- DHT11 y MQ-2 ----
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  int gasMv = leerMQ2();

  // ---- GPS ----
  bool gpsConectado = gps.charsProcessed() > 10;     // ¿llega algo por el UART?
  bool fix = gps.location.isValid() && gps.location.age() < GPS_VIGENCIA;
  bool altOk = gps.altitude.isValid() && gps.altitude.age() < GPS_VIGENCIA;
  bool hdopOk = gps.hdop.isValid() && gps.hdop.age() < GPS_VIGENCIA;
  int sats = gps.satellites.isValid() ? (int)gps.satellites.value() : 0;

  char payload[180];
  int n = snprintf(payload, sizeof(payload),
                   "B,%lu,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.2f,%.2f,%.2f,%u%u%u%u",
                   (unsigned long)seq, e.x(), e.y(), e.z(), g.x(), g.y(), g.z(),
                   a.x(), a.y(), a.z(), cs, cg, ca, cm);
  n += agregar(payload + n, sizeof(payload) - n, !isnan(t), ",%.0f", t);
  n += agregar(payload + n, sizeof(payload) - n, !isnan(h), ",%.0f", h);
  n += agregar(payload + n, sizeof(payload) - n, true, ",%.0f", gasMv);
  n += agregar(payload + n, sizeof(payload) - n, fix, ",%.5f", gps.location.lat());
  n += agregar(payload + n, sizeof(payload) - n, fix, ",%.5f", gps.location.lng());
  n += agregar(payload + n, sizeof(payload) - n, fix && altOk, ",%.0f", gps.altitude.meters());
  n += agregar(payload + n, sizeof(payload) - n, gpsConectado, ",%.0f", sats);
  n += agregar(payload + n, sizeof(payload) - n, fix && hdopOk, ",%.1f", gps.hdop.hdop());

  LoRa.beginPacket();
  LoRa.print(payload);
  // Bloqueante: en modo asíncrono, el parsePacket() del loop
  // cambia el radio a recepción y puede cortar la transmisión a la mitad.
  LoRa.endPacket();

  String lineaGps = !gpsConectado ? "GPS sin datos (cable?)"
                  : fix ? String(gps.location.lat(), 5) + "," + String(gps.location.lng(), 5)
                  : "GPS: buscando (" + String(sats) + " sat)";
  oledShow("TX #" + String(seq) + "  cal " + String(cs) + String(cg) + String(ca) + String(cm),
           "R:" + String(e.x(), 0) + " A:" + String(e.y(), 0) + " C:" + String(e.z(), 0),
           "T:" + (isnan(t) ? String("--") : String(t, 0)) + "C H:" + (isnan(h) ? String("--") : String(h, 0)) +
             "% gas:" + String(gasMv),
           lineaGps);

  Serial.print("TX: "); Serial.println(payload);
  seq++;
}

void loop() {
  leerGPS();

  // ---- Botón (envío manual) ----
  static bool lastBtn = HIGH;
  static bool sentOnPress = false;
  static unsigned long debTime = 0;

  bool reading = digitalRead(BTN_PIN);
  if (reading != lastBtn) debTime = millis();
  if ((millis() - debTime) > 40) {
    if (reading == LOW && !sentOnPress) {
      leerYEnviar();
      sentOnPress = true;
    }
    if (reading == HIGH) sentOnPress = false;
  }
  lastBtn = reading;

  // ---- Envío periódico cada SEND_INTERVAL_MS ----
  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    leerYEnviar();
  }

  // ---- RX (ACK / CONFIRM / REQ_B del Nodo B) ----
  int p = LoRa.parsePacket();
  if (p) {
    String msg = "";
    while (LoRa.available()) msg += (char)LoRa.read();

    if (msg == "CONFIRM_B") {
      digitalWrite(LED_CONFIRM, HIGH);
      oledShow("CONFIRM_B recibido", "Nodo B OK", "", "");
      delay(800);
      digitalWrite(LED_CONFIRM, LOW);
    }
    else if (msg == "REQ_B") {
      oledShow("REQ_B recibido", "Enviando datos...", "", "");
      leerYEnviar();
    }
    else if (msg.startsWith("ACK")) {
      oledShow("ACK recibido", msg, "", "");
    }
  }
}
