// =====================================================================
//  Monitor de bateria LiPo - LilyGO TTGO T3 LoRa32 V1.6.1
//  Muestra el voltaje y el porcentaje de la bateria en la pantalla OLED
//  y en el Monitor Serie (115200 baudios).
//
//  Librerias necesarias (Arduino IDE > Gestor de librerias):
//    - Adafruit SSD1306
//    - Adafruit GFX Library
//
//  Placa en Arduino IDE: "TTGO LoRa32-OLED" o "ESP32 Dev Module"
// =====================================================================

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// --- Pantalla OLED de la T3 V1.6.1 ---
#define OLED_SDA   21
#define OLED_SCL   22
#define OLED_ADDR  0x3C
#define ANCHO      128
#define ALTO       64

// --- Lectura de bateria ---
#define PIN_BATERIA     35    // ADC conectado a la bateria por un divisor 1:2
#define FACTOR_DIVISOR  2.0   // la placa reduce el voltaje a la mitad
#define MUESTRAS        16    // promediar varias lecturas reduce el ruido
#define VOLTAJE_BAJO    3.40  // debajo de esto se muestra aviso de bateria baja

Adafruit_SSD1306 pantalla(ANCHO, ALTO, &Wire, -1);

// Tabla aproximada voltaje -> porcentaje para una LiPo de 1 celda en reposo
const float tablaVoltaje[]    = {3.30, 3.50, 3.60, 3.70, 3.75, 3.80, 3.85, 3.90, 4.00, 4.10, 4.20};
const int   tablaPorcentaje[] = {   0,    5,   10,   25,   35,   45,   55,   65,   80,   90,  100};
const int   PUNTOS = sizeof(tablaVoltaje) / sizeof(tablaVoltaje[0]);

// Lee el voltaje real de la bateria en voltios
float leerVoltajeBateria() {
  uint32_t suma = 0;
  for (int i = 0; i < MUESTRAS; i++) {
    suma += analogReadMilliVolts(PIN_BATERIA);  // lectura calibrada en mV
    delay(2);
  }
  float milivoltios = suma / (float)MUESTRAS;
  return milivoltios * FACTOR_DIVISOR / 1000.0;
}

// Convierte voltaje a porcentaje interpolando en la tabla
int voltajeAPorcentaje(float v) {
  if (v <= tablaVoltaje[0])          return 0;
  if (v >= tablaVoltaje[PUNTOS - 1]) return 100;
  for (int i = 1; i < PUNTOS; i++) {
    if (v < tablaVoltaje[i]) {
      float t = (v - tablaVoltaje[i - 1]) / (tablaVoltaje[i] - tablaVoltaje[i - 1]);
      return tablaPorcentaje[i - 1] + t * (tablaPorcentaje[i] - tablaPorcentaje[i - 1]);
    }
  }
  return 100;
}

// Dibuja un icono de bateria relleno segun el porcentaje
void dibujarIconoBateria(int x, int y, int porcentaje) {
  const int ancho = 40, alto = 18;
  pantalla.drawRect(x, y, ancho, alto, SSD1306_WHITE);
  pantalla.fillRect(x + ancho, y + 5, 3, alto - 10, SSD1306_WHITE);  // terminal +
  int relleno = (ancho - 4) * porcentaje / 100;
  pantalla.fillRect(x + 2, y + 2, relleno, alto - 4, SSD1306_WHITE);
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);

  Wire.begin(OLED_SDA, OLED_SCL);
  if (!pantalla.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("No se encontro la pantalla OLED");
    while (true) delay(1000);
  }
  pantalla.clearDisplay();
  pantalla.display();
}

void loop() {
  float voltaje   = leerVoltajeBateria();
  int porcentaje  = voltajeAPorcentaje(voltaje);

  Serial.printf("Bateria: %.2f V  (%d %%)\n", voltaje, porcentaje);

  pantalla.clearDisplay();
  pantalla.setTextColor(SSD1306_WHITE);

  // Titulo
  pantalla.setTextSize(1);
  pantalla.setCursor(0, 0);
  pantalla.print("Bateria LiPo");
  if (voltaje < VOLTAJE_BAJO) {
    pantalla.setCursor(98, 0);
    pantalla.print("BAJA!");
  }

  // Voltaje grande
  pantalla.setTextSize(2);
  pantalla.setCursor(0, 16);
  pantalla.printf("%.2f V", voltaje);

  // Icono y porcentaje
  dibujarIconoBateria(0, 42, porcentaje);
  pantalla.setCursor(52, 44);
  pantalla.printf("%d%%", porcentaje);

  pantalla.display();
  delay(2000);  // actualizar cada 2 segundos
}
