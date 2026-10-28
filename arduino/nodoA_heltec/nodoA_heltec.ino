// ============================================================
//  COSTA · Nodo A (Heltec WiFi LoRa 32 V2) — va dentro del CanSat
//  Lee el BNO055 en modo NDOF (fusión de sensores) y transmite
//  por LoRa la orientación, velocidad angular, aceleración
//  lineal y estado de calibración.
//
//  Paquete (texto):
//    B,seq,rumbo,alabeo,cabeceo,wx,wy,wz,ax,ay,az,cal
//      rumbo/alabeo/cabeceo  -> grados (Euler del BNO055)
//      wx,wy,wz              -> °/s (giroscopio)
//      ax,ay,az              -> m/s² (aceleración lineal, sin gravedad)
//      cal                   -> 4 dígitos SGAM (sistema, giro, acel, mag), 0..3
//  Ejemplo: B,42,187.3,-2.1,4.6,0.3,-1.2,15.8,0.04,-0.11,0.20,3323
//
//  Librerías: LoRa (Sandeep Mistry), Adafruit BNO055, Adafruit Unified
//  Sensor, ESP8266 and ESP32 OLED driver for SSD1306 (ThingPulse)
// ============================================================
#include <SPI.h>
#include <LoRa.h>
#include <Wire.h>
#include "SSD1306.h"
#include <Adafruit_BNO055.h>
#include <Adafruit_Sensor.h>
#include <utility/imumaths.h>

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

// ===== Parámetros LoRa (IGUALES en A y B) =====
#define TX_POWER_DBM   17
#define LORA_SF        12
#define LORA_BW        125E3
#define LORA_SYNCWORD  0x12
#define LORA_PREAMBLE  8

// ===== Intervalo de envío periódico =====
// Con SF12 cada paquete tarda ~2 s en el aire; no bajes de ~4 s.
#define SEND_INTERVAL_MS  10000UL

Adafruit_BNO055 bno(55, 0x28);           // dirección I2C por defecto
SSD1306 display(OLED_ADDR, OLED_SDA, OLED_SCL);

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
           "o pulsa botón", "");
  lastSend = millis();
}

// Lee el BNO055 y transmite
void leerYEnviar() {
  // Orientación absoluta (grados): x = rumbo, y = alabeo, z = cabeceo
  imu::Vector<3> e = bno.getVector(Adafruit_BNO055::VECTOR_EULER);
  // Giroscopio: getVector() ya entrega °/s (no hace falta convertir)
  imu::Vector<3> g = bno.getVector(Adafruit_BNO055::VECTOR_GYROSCOPE);
  // Aceleración lineal (m/s², gravedad ya descontada)
  imu::Vector<3> a = bno.getVector(Adafruit_BNO055::VECTOR_LINEARACCEL);
  // Calibración 0..3 (3 = calibrado)
  uint8_t cs, cg, ca, cm;
  bno.getCalibration(&cs, &cg, &ca, &cm);

  char payload[96];
  snprintf(payload, sizeof(payload),
           "B,%lu,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.2f,%.2f,%.2f,%u%u%u%u",
           (unsigned long)seq, e.x(), e.y(), e.z(), g.x(), g.y(), g.z(),
           a.x(), a.y(), a.z(), cs, cg, ca, cm);

  LoRa.beginPacket();
  LoRa.print(payload);
  // Bloqueante (~2 s con SF12): en modo asíncrono, el parsePacket() del loop
  // cambia el radio a recepción y puede cortar la transmisión a la mitad.
  LoRa.endPacket();

  oledShow("TX -> Nodo B  #" + String(seq),
           "R:" + String(e.x(), 0) + " A:" + String(e.y(), 0) + " C:" + String(e.z(), 0),
           "w:" + String(g.x(), 0) + "," + String(g.y(), 0) + "," + String(g.z(), 0),
           "cal S" + String(cs) + " G" + String(cg) + " A" + String(ca) + " M" + String(cm));

  Serial.print("TX: "); Serial.println(payload);
  seq++;
}

void loop() {
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
