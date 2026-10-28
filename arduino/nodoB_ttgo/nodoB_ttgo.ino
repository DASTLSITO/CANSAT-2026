// ============================================================
//  COSTA · Nodo B (TTGO LoRa32) — estación terrena, conectado por USB a la PC
//  Recibe los paquetes LoRa del Nodo A y los reenvía por el puerto serial
//  para la API de Python (api/costa_api.py).
//
//  Salida serial (115200 baudios), una línea por evento:
//    RX,<rssi>,<snr>,<payload>     paquete LoRa recibido (ej. RX,-97,6.5,B,42,187.3,...)
//    # <texto>                     mensajes informativos (la API los guarda como eventos)
//
//  Entrada serial (comandos desde la PC):
//    REQ                           pide una lectura inmediata al Nodo A (igual que el botón)
//
//  Librerías: LoRa (Sandeep Mistry), ESP8266 and ESP32 OLED driver for SSD1306 (ThingPulse)
//
//  Placa en Arduino IDE (core de Heltec): "Heltec Wireless Stick Lite / Wireless Shell"
//  (ESP32 de 4 MB con cristal de 40 MHz, igual que el TTGO). No uses:
//   - "Heltec WiFi LoRa 32(V2)": fija 8 MB de flash y el TTGO se reinicia en bucle
//     ("Detected size(4096k) smaller than ... (8192k)").
//   - "Heltec WiFi LoRa 32" (V1) ni "WiFi Kit 32": fuerzan un cristal de 26 MHz
//     (F_XTAL_MHZ 26) y el puerto serial sale como basura a 115200 baudios.
// ============================================================
#include <SPI.h>
#include <LoRa.h>
#include <Wire.h>
#include "SSD1306.h"

// ===== TTGO LoRa32 =====
#define SCK   5
#define MISO  19
#define MOSI  27
#define SS    18
#define RST   14
#define DIO0  26
#define BAND  915E6

// ===== OLED TTGO =====
#define OLED_ADDR 0x3C
#define OLED_SDA  21
#define OLED_SCL  22
#define OLED_RST  23          // si tu placa usa 16, cambialo aquí

// ===== Botón / LED =====
#define BTN_PIN      13
#define LED_CONFIRM  2

// ===== Parámetros LoRa (IGUALES en A y B) =====
#define TX_POWER_DBM   17
#define LORA_SF        12
#define LORA_BW        125E3
#define LORA_SYNCWORD  0x12
#define LORA_PREAMBLE  8

SSD1306 display(OLED_ADDR, OLED_SDA, OLED_SCL);

uint32_t rxCount = 0;

// Debounce botón
bool lastStable = HIGH, lastRead = HIGH;
unsigned long lastChangeMs = 0;
const unsigned long debounceMs = 40;

// Confirmación diferida para que A encienda su LED
bool confirmPending = false;
unsigned long confirmDue = 0;

// Comando recibido por USB
String serialCmd = "";

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
  // Indicador de botón en la esquina
  String tag = (digitalRead(BTN_PIN) == LOW) ? "[*]" : "[ ]";
  display.drawString(108, 0, tag);
  display.display();
}

void sendLoRa(const String& msg) {
  LoRa.beginPacket();
  LoRa.print(msg);
  LoRa.endPacket();              // bloqueante: parsePacket() no interrumpe la transmisión
}

void sendReqB() {
  oledShow("Solicitando...", "REQ_B -> Nodo A", "", "");
  digitalWrite(LED_CONFIRM, HIGH);
  sendLoRa("REQ_B");
  digitalWrite(LED_CONFIRM, LOW);
  Serial.println("# REQ_B enviado al Nodo A");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_CONFIRM, OUTPUT);
  digitalWrite(LED_CONFIRM, LOW);
  pinMode(BTN_PIN, INPUT_PULLUP);

  // ---- OLED ----
  pinMode(OLED_RST, OUTPUT);
  digitalWrite(OLED_RST, LOW);
  delay(20);
  digitalWrite(OLED_RST, HIGH);
  delay(20);
  Wire.begin(OLED_SDA, OLED_SCL);
  Wire.setClock(100000);
  display.init();
  display.flipScreenVertically();
  oledShow("Nodo B listo", "Esperando datos...", "", "");

  // ---- LoRa ----
  SPI.begin(SCK, MISO, MOSI);
  LoRa.setPins(SS, RST, DIO0);
  if (!LoRa.begin(BAND)) {
    oledShow("Error LoRa", "Revisa módulo", "", "");
    Serial.println("# Error: LoRa no inicia");
    while (1) delay(1000);
  }
  LoRa.setTxPower(TX_POWER_DBM);
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW);
  LoRa.setPreambleLength(LORA_PREAMBLE);
  LoRa.setSyncWord(LORA_SYNCWORD);
  LoRa.setCodingRate4(8);
  LoRa.enableCrc();
  Serial.println("# Nodo B listo");
}

void processButtonB() {
  bool r = digitalRead(BTN_PIN);
  unsigned long now = millis();
  if (r != lastRead) { lastRead = r; lastChangeMs = now; }
  if ((now - lastChangeMs) > debounceMs && lastStable != lastRead) {
    lastStable = lastRead;
    if (lastStable == LOW) sendReqB();
  }
}

void processSerialCmd() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      serialCmd.trim();
      if (serialCmd == "REQ") sendReqB();
      else if (serialCmd.length()) Serial.println("# Comando desconocido: " + serialCmd);
      serialCmd = "";
    } else if (serialCmd.length() < 32) {
      serialCmd += c;
    }
  }
}

// Devuelve el campo n (0 = primero) de una lista separada por comas
String campo(const String& s, int n) {
  int ini = 0;
  for (int i = 0; i < n; i++) {
    ini = s.indexOf(',', ini) + 1;
    if (ini == 0) return "";
  }
  int fin = s.indexOf(',', ini);
  return fin < 0 ? s.substring(ini) : s.substring(ini, fin);
}

void processLoRaRx() {
  int p = LoRa.parsePacket();
  if (!p) return;

  String msg = "";
  while (LoRa.available()) msg += (char)LoRa.read();
  int rssi = LoRa.packetRssi();
  float snr = LoRa.packetSnr();
  String link = "RSSI:" + String(rssi) + " SNR:" + String(snr, 1);

  // Línea para la API: RX,<rssi>,<snr>,<payload>
  Serial.print("RX,"); Serial.print(rssi); Serial.print(","); Serial.print(snr, 1);
  Serial.print(","); Serial.println(msg);

  if (msg.startsWith("B,") || msg.startsWith("G,")) {
    rxCount++;
    String seq = campo(msg, 1);
    if (msg.startsWith("B,")) {
      oledShow("SEQ:" + seq + "  RX:" + String(rxCount),
               "R:" + campo(msg, 2) + " A:" + campo(msg, 3) + " C:" + campo(msg, 4),
               "w:" + campo(msg, 5) + "," + campo(msg, 6) + "," + campo(msg, 7),
               link);
    } else {
      oledShow("SEQ:" + seq + "  RX:" + String(rxCount),
               "w:" + campo(msg, 4) + "," + campo(msg, 5) + "," + campo(msg, 6),
               "(formato G antiguo)", link);
    }
    sendLoRa("ACK," + seq);
    confirmPending = true;
    confirmDue = millis() + 1500;
  } else {
    oledShow("RX:", msg, link, "");
  }
}

void loop() {
  processButtonB();
  processSerialCmd();
  processLoRaRx();
  if (confirmPending && (int32_t)(millis() - confirmDue) >= 0) {
    sendLoRa("CONFIRM_B");
    confirmPending = false;
  }
}
