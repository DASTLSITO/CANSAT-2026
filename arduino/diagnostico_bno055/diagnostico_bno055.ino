// ============================================================
//  Pyro-SCOUT · Diagnóstico del BNO055 (cargar en el Nodo A, Heltec V2)
//  Solo para pruebas en mesa: imprime por el Monitor Serie (115200)
//  el autotest de cada sensor, el modo, la calibración y los datos.
//
//  Cambia cada 10 s entre tres pruebas:
//    1. NDOF + reloj interno  -> fusión (lo que usa el vuelo): debe dar orientación
//    2. NDOF + cristal externo -> si aquí todo sale en 0 y en la 1 no, el módulo
//                                 no tiene un cristal de 32.768 kHz funcional
//    3. AMG (sin fusión)      -> sensores crudos: la orientación sale en 0 (normal),
//                                 pero el giroscopio debe moverse al girar
//  Placa: "Heltec WiFi LoRa 32(V2)". Después vuelve a cargar nodoA_heltec.
// ============================================================
#include <Wire.h>
#include <Adafruit_BNO055.h>
#include <Adafruit_Sensor.h>
#include <utility/imumaths.h>

#define OLED_SDA  4      // mismo bus I2C que usa el Nodo A
#define OLED_SCL  15
#define VEXT_PIN  21

Adafruit_BNO055 bno(55, 0x28);
// Pruebas: 0 = NDOF reloj interno, 1 = NDOF cristal externo, 2 = AMG
const char* NOMBRE_PRUEBA[] = {"NDOF + reloj interno", "NDOF + cristal externo", "AMG (crudo, sin fusión)"};
int prueba = 0;
unsigned long cambioModo = 0;

void aplicarPrueba() {
  bno.setExtCrystalUse(prueba == 1);   // deja el chip en el modo anterior; luego se fija el pedido
  bno.setMode(prueba == 2 ? OPERATION_MODE_AMG : OPERATION_MODE_NDOF);
  delay(100);
  Serial.printf("\n>>> Prueba %d: %s\n", prueba + 1, NOMBRE_PRUEBA[prueba]);
}

const char* textoEstado(uint8_t s) {
  switch (s) {
    case 0: return "inactivo";
    case 1: return "ERROR de sistema";
    case 2: return "iniciando periféricos";
    case 3: return "iniciando";
    case 4: return "ejecutando autotest";
    case 5: return "OK, con fusión";
    case 6: return "OK, sin fusión";
    default: return "desconocido";
  }
}

void escanearI2C() {
  Serial.print("Dispositivos I2C encontrados:");
  for (uint8_t dir = 1; dir < 127; dir++) {
    Wire.beginTransmission(dir);
    if (Wire.endTransmission() == 0) Serial.printf(" 0x%02X", dir);
  }
  Serial.println("   (BNO055 = 0x28 o 0x29, OLED = 0x3C)");
}

void imprimirVector(const char* nombre, imu::Vector<3> v, const char* unidad) {
  Serial.printf("  %-14s x=%8.2f  y=%8.2f  z=%8.2f  %s\n", nombre, v.x(), v.y(), v.z(), unidad);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  pinMode(VEXT_PIN, OUTPUT);
  digitalWrite(VEXT_PIN, LOW);
  Wire.begin(OLED_SDA, OLED_SCL);
  Wire.setClock(100000);

  Serial.println("\n=== Diagnóstico BNO055 ===");
  escanearI2C();

  if (!bno.begin(OPERATION_MODE_NDOF)) {
    Serial.println("ERROR: el BNO055 no responde en 0x28. Revisa VIN, GND, SDA, SCL y el pin ADR.");
    while (1) delay(1000);
  }
  delay(500);

  Adafruit_BNO055::adafruit_bno055_rev_info_t rev;
  bno.getRevInfo(&rev);
  Serial.printf("Firmware SW %04X · bootloader %u · IDs acel %02X mag %02X giro %02X\n",
                rev.sw_rev, rev.bl_rev, rev.accel_rev, rev.mag_rev, rev.gyro_rev);
  aplicarPrueba();
  cambioModo = millis();
}

void loop() {
  // Cambia de prueba cada 10 s
  if (millis() - cambioModo > 10000) {
    prueba = (prueba + 1) % 3;
    aplicarPrueba();
    cambioModo = millis();
  }

  uint8_t estado, autotest, error;
  bno.getSystemStatus(&estado, &autotest, &error);
  uint8_t cs, cg, ca, cm;
  bno.getCalibration(&cs, &cg, &ca, &cm);

  Serial.println("------------------------------------------------------------");
  Serial.printf("Prueba %d (%s) · modo real: 0x%02X · estado: %u (%s) · error: %u\n",
                prueba + 1, NOMBRE_PRUEBA[prueba], (uint8_t)bno.getMode(), estado, textoEstado(estado), error);
  // Autotest: bit0 acelerómetro, bit1 magnetómetro, bit2 giroscopio, bit3 MCU (1 = pasó)
  Serial.printf("Autotest: acel %s · mag %s · giro %s · MCU %s   (0x%02X)\n",
                autotest & 0x01 ? "OK" : "FALLA", autotest & 0x02 ? "OK" : "FALLA",
                autotest & 0x04 ? "OK" : "FALLA", autotest & 0x08 ? "OK" : "FALLA", autotest);
  Serial.printf("Calibración: sistema %u · giro %u · acel %u · mag %u · temperatura chip %d °C\n",
                cs, cg, ca, cm, bno.getTemp());

  imprimirVector("Acelerómetro", bno.getVector(Adafruit_BNO055::VECTOR_ACCELEROMETER), "m/s² (en reposo |a| ~ 9.8)");
  imprimirVector("Giroscopio", bno.getVector(Adafruit_BNO055::VECTOR_GYROSCOPE), "°/s (gíralo: debe cambiar)");
  imprimirVector("Magnetómetro", bno.getVector(Adafruit_BNO055::VECTOR_MAGNETOMETER), "µT");
  imprimirVector("Euler", bno.getVector(Adafruit_BNO055::VECTOR_EULER), "° rumbo/alabeo/cabeceo (0 en AMG)");
  imprimirVector("Acel. lineal", bno.getVector(Adafruit_BNO055::VECTOR_LINEARACCEL), "m/s² (0 en AMG)");

  delay(1000);
}
