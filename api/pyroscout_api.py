"""
Pyro-SCOUT · API de telemetría (Python)

Lee por USB el Nodo B (receptor LoRa), interpreta los paquetes del Nodo A
(BNO055, DHT11, MQ-2, UVM30A y GPS), los guarda en una bitácora SQLite (data/bitacora.db) y los entrega al dashboard.

    GET  /api/estado                 estado del puerto, sesión actual y conteos
    GET  /api/historial?n=500        últimas lecturas de la sesión actual (para gráficas)
    GET  /api/stream                 lecturas y estado en vivo (Server-Sent Events)
    POST /api/solicitar              pide una lectura inmediata al Nodo A (vía Nodo B)

    GET  /api/sesiones               lista de sesiones de la bitácora
    POST /api/sesiones               abre una nueva sesión  {"nombre": "Lanzamiento 1"}
    GET  /api/bitacora               lecturas paginadas  ?sesion=&pagina=&limite=&desde=&hasta=
    GET  /api/bitacora.csv           exporta una sesión  ?sesion=
    GET  /api/bitacora/eventos       eventos de una sesión  ?sesion=&limite=

Formato que imprime el Nodo B (una línea por paquete):
    RX,<rssi>,<snr>,B,seq,rumbo,alabeo,cabeceo,wx,wy,wz,ax,ay,az,cal,temp,hum,gas,lat,lon,alt,sats,hdop,qw,qx,qy,qz,uv
    RX,<rssi>,<snr>,B,...,hdop                                       (sin cuaternión: 20 campos)
    RX,<rssi>,<snr>,INFO,<texto>                                     (aviso del Nodo A -> evento)
    RX,<rssi>,<snr>,B,seq,rumbo,alabeo,cabeceo,wx,wy,wz,ax,ay,az,cal   (firmware solo con BNO055)
    RX,<rssi>,<snr>,G,seq,t,h,wx,wy,wz,gas          (firmware anterior: solo se usa el giroscopio)
    # <mensaje>                                      (informativo, se guarda como evento)

Uso:
    python pyroscout_api.py                  # lee el Nodo B en /dev/ttyACM0
"""

import argparse
import asyncio
import csv
import io
import json
import math
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import serial
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from bitacora import Bitacora, COLUMNAS_LECTURA, ahora_ms

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Puerto del Nodo B. La API solo intenta conectarse aquí.
PUERTO_NODO_B = "/dev/ttyACM0"

# El firmware anterior del Nodo A multiplicaba el giroscopio por 57.3 creyendo que venía en rad/s,
# pero getVector() de Adafruit ya entrega °/s. Se corrige al recibir paquetes con formato "G".
CORRECCION_GIRO_FORMATO_G = 1 / 57.2958

bitacora: Bitacora | None = None
suscriptores: set[asyncio.Queue] = set()
loop_principal: asyncio.AbstractEventLoop | None = None
estado = {"puerto": None, "conectado": False, "error": None, "descartadas": 0, "ultima_t": None}

puerto_serial: serial.Serial | None = None
lock_escritura = threading.Lock()
ultimo_seq: int | None = None


# ---------- difusión a los navegadores ----------
def difundir(evento: str, datos: dict):
    """Se llama desde el hilo serial; entrega el mensaje al loop de asyncio."""
    if loop_principal is None:
        return
    msg = f"event: {evento}\ndata: {json.dumps(datos)}\n\n"
    for q in list(suscriptores):
        loop_principal.call_soon_threadsafe(q.put_nowait, msg)


def estado_completo() -> dict:
    return {**estado, "sesion": bitacora.sesion, **bitacora.contar_sesion()}


def actualizar_estado(**cambios):
    estado.update(cambios)
    difundir("estado", estado_completo())


def registrar_evento(tipo: str, detalle: str = ""):
    difundir("evento", bitacora.evento(tipo, detalle))


# ---------- interpretación de paquetes ----------
def _num(s: str) -> float:
    v = float(s)
    if not math.isfinite(v):
        raise ValueError(s)
    return v


def _opc(s: str, tipo=float, minimo=None, maximo=None):
    """Campo opcional: vacío -> None. Valores fuera de rango -> ValueError."""
    s = s.strip()
    if not s:
        return None
    v = tipo(_num(s))
    if (minimo is not None and v < minimo) or (maximo is not None and v > maximo):
        raise ValueError(f"valor fuera de rango: {s}")
    return v


# UVM30A: mV de salida en el límite inferior de cada índice UV 0..11 (hoja de datos del sensor)
TABLA_UVM30A = [50, 227, 318, 408, 503, 606, 696, 795, 881, 976, 1079, 1170]


def indice_uv(mv: int | None) -> float | None:
    """Convierte los mV del UVM30A a índice UV, interpolando entre los puntos de la tabla."""
    if mv is None:
        return None
    t = TABLA_UVM30A
    if mv < t[0]:
        return 0.0
    for i in range(1, len(t)):
        if mv < t[i]:
            return round((i - 1) + (mv - t[i - 1]) / (t[i] - t[i - 1]), 1)
    return round(11 + (mv - t[-1]) / 91, 1)      # arriba de 11: misma pendiente que el último tramo


def interpretar_payload(payload: str) -> dict:
    """Convierte 'B,...' o 'G,...' en un diccionario. Lanza ValueError si está mal formado.

    B con 12 campos: solo BNO055.  20: + DHT11, MQ-2 y GPS.  24: + cuaternión.  25: + UVM30A."""
    p = payload.strip().split(",")
    if p[0] == "B" and len(p) in (12, 20, 24, 25):
        cal = p[11].strip()
        if len(cal) != 4 or not cal.isdigit():
            raise ValueError("calibración inválida")
        d = {
            "formato": "B", "seq": int(p[1]),
            "rumbo": _num(p[2]), "alabeo": _num(p[3]), "cabeceo": _num(p[4]),
            "wx": _num(p[5]), "wy": _num(p[6]), "wz": _num(p[7]),
            "ax": _num(p[8]), "ay": _num(p[9]), "az": _num(p[10]),
            "cal_sys": int(cal[0]), "cal_giro": int(cal[1]), "cal_acel": int(cal[2]), "cal_mag": int(cal[3]),
        }
        if len(p) >= 20:
            d.update({
                "temp": _opc(p[12], float, -40, 85), "hum": _opc(p[13], float, 0, 100),
                "gas_mv": _opc(p[14], int, 0, 6000),
                "lat": _opc(p[15], float, -90, 90), "lon": _opc(p[16], float, -180, 180),
                "alt_gps": _opc(p[17], float, -500, 50000),
                "sats": _opc(p[18], int, 0, 99), "hdop": _opc(p[19], float, 0, 100),
            })
            if (d["lat"] is None) != (d["lon"] is None):
                raise ValueError("GPS con latitud o longitud incompleta")
        if len(p) >= 24:
            q = [_num(x) for x in p[20:24]]
            norma = math.sqrt(sum(c * c for c in q))
            if norma < 0.5:            # el BNO055 entrega todo en 0 cuando la fusión no corre
                q = [None] * 4
            else:
                q = [round(c / norma, 4) for c in q]
            d.update({"qw": q[0], "qx": q[1], "qy": q[2], "qz": q[3]})
        if len(p) == 25:
            d["uv_mv"] = _opc(p[24], int, 0, 3300)
            d["uv"] = indice_uv(d["uv_mv"])
        return d
    if p[0] == "G" and len(p) == 8:
        # G,seq,t,h,wx,wy,wz,gas -> solo interesa el giroscopio del BNO055
        k = CORRECCION_GIRO_FORMATO_G
        return {"formato": "G", "seq": int(p[1]),
                "wx": round(_num(p[4]) * k, 2), "wy": round(_num(p[5]) * k, 2), "wz": round(_num(p[6]) * k, 2)}
    raise ValueError(f"formato desconocido ({p[0]}, {len(p)} campos)")


def registrar_lectura(d: dict, crudo: str):
    global ultimo_seq
    d["t"] = ahora_ms()
    d["crudo"] = crudo
    d["w_mag"] = round(math.sqrt(d["wx"] ** 2 + d["wy"] ** 2 + d["wz"] ** 2), 2)
    if d.get("ax") is not None:
        d["a_mag"] = round(math.sqrt(d["ax"] ** 2 + d["ay"] ** 2 + d["az"] ** 2), 3)

    # Huecos en el número de secuencia = paquetes LoRa que no llegaron
    d["perdidos"] = 0
    seq = d["seq"]
    if ultimo_seq is not None:
        if seq > ultimo_seq + 1:
            d["perdidos"] = seq - ultimo_seq - 1
            registrar_evento("perdidos", f"Faltan {d['perdidos']} paquete(s) entre #{ultimo_seq} y #{seq}")
        elif seq == ultimo_seq:
            registrar_evento("duplicado", f"Paquete #{seq} repetido")
        elif seq < ultimo_seq:
            registrar_evento("reinicio_nodo_a", f"La secuencia volvió de #{ultimo_seq} a #{seq} (¿se reinició el Nodo A?)")
    ultimo_seq = seq

    fila = bitacora.guardar_lectura(d)
    estado["ultima_t"] = fila["t"]
    difundir("lectura", fila)


def procesar_linea(linea: str):
    linea = linea.strip()
    if not linea:
        return
    rssi = snr = None
    if linea.startswith("RX,"):                 # firmware nuevo del Nodo B
        partes = linea.split(",", 3)
        if len(partes) < 4:
            return descartar(linea, "línea RX incompleta")
        try:
            rssi, snr = int(float(partes[1])), float(partes[2])
        except ValueError:
            return descartar(linea, "RSSI/SNR inválidos")
        payload = partes[3]
    elif linea.startswith("RX: "):              # firmware anterior del Nodo B (sin RSSI/SNR)
        payload = linea[4:]
    elif linea.startswith("TX: "):              # Nodo A conectado directo por USB (pruebas en mesa)
        payload = linea[4:]
    elif linea.startswith("#"):
        return registrar_evento("nodo_b", linea.lstrip("# "))
    else:
        return registrar_evento("serial", linea[:200])

    if payload.startswith("INFO,"):
        return registrar_evento("nodo_a", payload[5:200])
    if not (payload.startswith("B,") or payload.startswith("G,")):
        return registrar_evento("mensaje_lora", payload[:200])
    try:
        d = interpretar_payload(payload)
    except (ValueError, IndexError) as e:
        return descartar(linea, str(e))
    d["rssi"], d["snr"] = rssi, snr
    registrar_lectura(d, linea)


def descartar(linea: str, motivo: str):
    estado["descartadas"] += 1
    registrar_evento("invalido", f"{motivo}: {linea[:200]}")


# ---------- lectura serial ----------
def hilo_serial(puerto: str, baudios: int):
    global puerto_serial
    avisado = False
    while True:
        if not Path(puerto).exists():
            if not avisado:
                actualizar_estado(conectado=False, puerto=puerto, error=f"No se encontró el Nodo B en {puerto} (¿está conectado?)")
                registrar_evento("desconexion", f"No existe {puerto}")
                print(f"  Esperando al Nodo B en {puerto}…", flush=True)
                avisado = True
            time.sleep(2)
            continue
        try:
            with serial.Serial(puerto, baudios, timeout=1) as ser:
                puerto_serial = ser
                avisado = False
                actualizar_estado(conectado=True, puerto=puerto, error=None)
                registrar_evento("conexion", f"Nodo B conectado en {puerto} @ {baudios}")
                print(f"  Nodo B conectado en {puerto} @ {baudios}", flush=True)
                # No se usa readline(): con timeout devuelve media línea si esta empieza a llegar
                # justo antes de que venza, y la lectura se pierde. Se acumula hasta cada '\n'.
                pendiente = b""
                while True:
                    pendiente += ser.read(ser.in_waiting or 1)
                    while b"\n" in pendiente:
                        linea, pendiente = pendiente.split(b"\n", 1)
                        procesar_linea(linea.decode("utf-8", errors="replace"))
                    if len(pendiente) > 4096:          # basura sin saltos de línea
                        pendiente = b""
        except (serial.SerialException, OSError) as e:
            puerto_serial = None
            if not avisado:
                error = str(e)
                if "Permission denied" in error or "Errno 13" in error:
                    error = (f"Sin permiso para abrir {puerto}. Ejecuta: sudo usermod -aG dialout $USER "
                             "y cierra sesión (o reinicia) para que aplique")
                actualizar_estado(conectado=False, puerto=puerto, error=error)
                registrar_evento("desconexion", f"{puerto}: {error}")
                print(f"  Puerto {puerto}: {error}; reintentando…", flush=True)
                avisado = True
            time.sleep(2)


# ---------- API ----------
@asynccontextmanager
async def ciclo_de_vida(_app):
    global loop_principal, ultimo_seq
    loop_principal = asyncio.get_running_loop()
    ultimo_seq = bitacora.ultimo_seq()
    threading.Thread(target=hilo_serial, args=(PUERTO_NODO_B, ARGS.baudios), daemon=True).start()
    yield


app = FastAPI(title="Pyro-SCOUT · API de telemetría", lifespan=ciclo_de_vida)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/estado")
def get_estado():
    return estado_completo()


@app.get("/api/historial")
def get_historial(n: int = 500):
    return bitacora.ultimas(max(1, min(n, 5000)))


@app.post("/api/solicitar")
def solicitar_lectura():
    if puerto_serial is None:
        raise HTTPException(409, "El Nodo B no está conectado")
    with lock_escritura:
        puerto_serial.write(b"REQ\n")
    registrar_evento("solicitud", "Lectura solicitada desde el dashboard")
    return {"ok": True}


class NuevaSesion(BaseModel):
    nombre: str | None = None


@app.get("/api/sesiones")
def get_sesiones():
    return bitacora.sesiones()


@app.post("/api/sesiones")
def crear_sesion(datos: NuevaSesion):
    global ultimo_seq
    s = bitacora.nueva_sesion(datos.nombre)
    ultimo_seq = None
    registrar_evento("sesion", f"Inicio de «{s['nombre']}»")
    difundir("sesion", s)
    difundir("estado", estado_completo())
    return s


def _sesion_o_actual(sesion: int | None) -> int:
    sid = sesion or bitacora.sesion["id"]
    if not bitacora.sesion_existe(sid):
        raise HTTPException(404, "Sesión no encontrada")
    return sid


@app.get("/api/bitacora")
def get_bitacora(sesion: int | None = None, pagina: int = 1, limite: int = 50,
                 desde: int | None = None, hasta: int | None = None):
    sid = _sesion_o_actual(sesion)
    limite = max(1, min(limite, 1000))
    pagina = max(1, pagina)
    total, filas = bitacora.lecturas(sid, desde, hasta, limite, (pagina - 1) * limite)
    return {"sesion": sid, "total": total, "pagina": pagina, "limite": limite, "filas": filas}


@app.get("/api/bitacora/eventos")
def get_eventos(sesion: int | None = None, limite: int = 100):
    return bitacora.eventos(_sesion_o_actual(sesion), max(1, min(limite, 1000)))


@app.get("/api/bitacora.csv")
def exportar_csv(sesion: int | None = None):
    sid = _sesion_o_actual(sesion)
    columnas = ["fecha_hora", *COLUMNAS_LECTURA]

    def filas():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(columnas)
        for f in bitacora.iterar_lecturas(sid):
            fecha = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(f["t"] / 1000))
            w.writerow([fecha, *[f[c] if f[c] is not None else "" for c in COLUMNAS_LECTURA]])
            if buf.tell() > 64_000:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        yield buf.getvalue()

    nombre = f"pyroscout_bitacora_sesion_{sid}.csv"
    return StreamingResponse(filas(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{nombre}"'})


@app.get("/api/stream")
async def stream():
    q: asyncio.Queue = asyncio.Queue()
    suscriptores.add(q)

    async def generar():
        try:
            yield "retry: 2000\n\n"
            yield f"event: estado\ndata: {json.dumps(estado_completo())}\n\n"
            while True:
                try:
                    yield await asyncio.wait_for(q.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            suscriptores.discard(q)

    return StreamingResponse(generar(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="API de telemetría del CanSat Pyro-SCOUT")
    ap.add_argument("--baudios", type=int, default=115200)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000, help="Puerto HTTP de la API")
    ap.add_argument("--db", type=Path, help="Archivo SQLite (por defecto data/bitacora.db)")
    ARGS = ap.parse_args()

    ruta_db = ARGS.db or DATA_DIR / "bitacora.db"
    bitacora = Bitacora(ruta_db)

    print(f"\n  Pyro-SCOUT · API de telemetría en http://localhost:{ARGS.port}  (docs: /docs)")
    print(f"  Bitácora: {ruta_db}  ·  sesión actual: {bitacora.sesion['nombre']}")
    print(flush=True)
    # timeout_graceful_shutdown: el stream en vivo del dashboard nunca se cierra solo; sin esto Ctrl+C se queda esperando
    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="warning", timeout_graceful_shutdown=1)
