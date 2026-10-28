"""
Bitácora SQLite de la misión COSTA.

Tablas:
    sesiones  -> cada "misión" o prueba (se abre una nueva desde el dashboard)
    lecturas  -> un renglón por paquete recibido por LoRa (BNO055, DHT11, MQ-2 y GPS)
    eventos   -> conexiones del puerto, mensajes del Nodo B, paquetes perdidos o inválidos, etc.

Los tiempos (columna t) son milisegundos Unix con la hora de la PC al recibir el paquete.
"""

import sqlite3
import threading
import time
from pathlib import Path

ESQUEMA = """
CREATE TABLE IF NOT EXISTS sesiones (
    id      INTEGER PRIMARY KEY,
    nombre  TEXT    NOT NULL,
    inicio  INTEGER NOT NULL,
    fin     INTEGER
);

CREATE TABLE IF NOT EXISTS lecturas (
    id        INTEGER PRIMARY KEY,
    sesion_id INTEGER NOT NULL REFERENCES sesiones(id),
    t         INTEGER NOT NULL,
    seq       INTEGER,
    formato   TEXT,                 -- 'B' (BNO055 completo) o 'G' (formato antiguo, solo giroscopio)
    rumbo     REAL, alabeo REAL, cabeceo REAL,          -- grados
    wx        REAL, wy REAL, wz REAL, w_mag REAL,       -- °/s
    ax        REAL, ay REAL, az REAL, a_mag REAL,       -- m/s² (aceleración lineal)
    cal_sys   INTEGER, cal_giro INTEGER, cal_acel INTEGER, cal_mag INTEGER,  -- 0..3
    temp      REAL, hum REAL,                         -- °C y % (DHT11)
    gas_mv    INTEGER,                                -- mV en la salida AO del MQ-2
    lat       REAL, lon REAL, alt_gps REAL,           -- grados decimales y m (GPS)
    sats      INTEGER, hdop REAL,                     -- satélites en uso y precisión horizontal
    rssi      INTEGER,              -- dBm
    snr       REAL,                 -- dB
    perdidos  INTEGER NOT NULL DEFAULT 0,  -- paquetes que faltaron justo antes de este (huecos en seq)
    crudo     TEXT                  -- línea original tal como llegó del Nodo B
);
CREATE INDEX IF NOT EXISTS ix_lecturas_sesion_t ON lecturas(sesion_id, t);

CREATE TABLE IF NOT EXISTS eventos (
    id        INTEGER PRIMARY KEY,
    sesion_id INTEGER REFERENCES sesiones(id),
    t         INTEGER NOT NULL,
    tipo      TEXT    NOT NULL,
    detalle   TEXT
);
CREATE INDEX IF NOT EXISTS ix_eventos_sesion_t ON eventos(sesion_id, t);
"""

COLUMNAS_LECTURA = [
    "t", "seq", "formato", "rumbo", "alabeo", "cabeceo", "wx", "wy", "wz", "w_mag",
    "ax", "ay", "az", "a_mag", "cal_sys", "cal_giro", "cal_acel", "cal_mag",
    "temp", "hum", "gas_mv", "lat", "lon", "alt_gps", "sats", "hdop",
    "rssi", "snr", "perdidos", "crudo",
]


def ahora_ms() -> int:
    return int(time.time() * 1000)


class Bitacora:
    def __init__(self, ruta: Path):
        ruta.parent.mkdir(parents=True, exist_ok=True)
        self.ruta = ruta
        self._lock = threading.Lock()
        self._db = sqlite3.connect(ruta, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(ESQUEMA)
        self._migrar()
        # Retoma la última sesión abierta; si no hay, crea la primera
        fila = self._db.execute("SELECT * FROM sesiones WHERE fin IS NULL ORDER BY id DESC LIMIT 1").fetchone()
        self.sesion = dict(fila) if fila else None
        if self.sesion is None:
            self.nueva_sesion()

    def _migrar(self):
        """Agrega a una bitácora vieja las columnas que se sumaron después (no borra nada)."""
        nuevas = {"temp": "REAL", "hum": "REAL", "gas_mv": "INTEGER", "lat": "REAL", "lon": "REAL",
                  "alt_gps": "REAL", "sats": "INTEGER", "hdop": "REAL"}
        existentes = {f["name"] for f in self._db.execute("PRAGMA table_info(lecturas)")}
        with self._db:
            for col, tipo in nuevas.items():
                if col not in existentes:
                    self._db.execute(f"ALTER TABLE lecturas ADD COLUMN {col} {tipo}")

    # ---------- sesiones ----------
    def nueva_sesion(self, nombre: str | None = None) -> dict:
        t = ahora_ms()
        with self._lock, self._db:
            if self.sesion:
                self._db.execute("UPDATE sesiones SET fin = ? WHERE id = ?", (t, self.sesion["id"]))
            n = self._db.execute("SELECT COUNT(*) FROM sesiones").fetchone()[0] + 1
            nombre = (nombre or "").strip() or f"Sesión {n}"
            cur = self._db.execute("INSERT INTO sesiones (nombre, inicio) VALUES (?, ?)", (nombre, t))
            self.sesion = {"id": cur.lastrowid, "nombre": nombre, "inicio": t, "fin": None}
        return self.sesion

    def sesiones(self) -> list[dict]:
        with self._lock:
            filas = self._db.execute("""
                SELECT s.*, COUNT(l.id) AS lecturas, COALESCE(SUM(l.perdidos), 0) AS perdidos,
                       MIN(l.t) AS primera, MAX(l.t) AS ultima
                FROM sesiones s LEFT JOIN lecturas l ON l.sesion_id = s.id
                GROUP BY s.id ORDER BY s.id DESC
            """).fetchall()
        return [dict(f) for f in filas]

    def sesion_existe(self, sesion_id: int) -> bool:
        with self._lock:
            return self._db.execute("SELECT 1 FROM sesiones WHERE id = ?", (sesion_id,)).fetchone() is not None

    # ---------- escritura ----------
    def guardar_lectura(self, d: dict) -> dict:
        fila = {c: d.get(c) for c in COLUMNAS_LECTURA}
        fila["sesion_id"] = self.sesion["id"]
        cols = ", ".join(fila)
        marcas = ", ".join("?" for _ in fila)
        with self._lock, self._db:
            cur = self._db.execute(f"INSERT INTO lecturas ({cols}) VALUES ({marcas})", list(fila.values()))
        fila["id"] = cur.lastrowid
        return fila

    def evento(self, tipo: str, detalle: str = "") -> dict:
        e = {"sesion_id": self.sesion["id"], "t": ahora_ms(), "tipo": tipo, "detalle": detalle}
        with self._lock, self._db:
            cur = self._db.execute("INSERT INTO eventos (sesion_id, t, tipo, detalle) VALUES (?, ?, ?, ?)",
                                   (e["sesion_id"], e["t"], tipo, detalle))
        e["id"] = cur.lastrowid
        return e

    # ---------- lectura ----------
    def ultimo_seq(self) -> int | None:
        with self._lock:
            f = self._db.execute("SELECT seq FROM lecturas WHERE sesion_id = ? ORDER BY id DESC LIMIT 1",
                                 (self.sesion["id"],)).fetchone()
        return f["seq"] if f else None

    def contar_sesion(self) -> dict:
        with self._lock:
            f = self._db.execute("SELECT COUNT(*) AS n, COALESCE(SUM(perdidos), 0) AS perdidos FROM lecturas WHERE sesion_id = ?",
                                 (self.sesion["id"],)).fetchone()
        return {"lecturas": f["n"], "perdidos": f["perdidos"]}

    def lecturas(self, sesion_id: int, desde: int | None = None, hasta: int | None = None,
                 limite: int = 100, offset: int = 0, recientes_primero: bool = True) -> tuple[int, list[dict]]:
        filtro = "sesion_id = ?"
        params: list = [sesion_id]
        if desde is not None:
            filtro += " AND t >= ?"
            params.append(desde)
        if hasta is not None:
            filtro += " AND t <= ?"
            params.append(hasta)
        orden = "DESC" if recientes_primero else "ASC"
        with self._lock:
            total = self._db.execute(f"SELECT COUNT(*) FROM lecturas WHERE {filtro}", params).fetchone()[0]
            filas = self._db.execute(
                f"SELECT * FROM lecturas WHERE {filtro} ORDER BY t {orden}, id {orden} LIMIT ? OFFSET ?",
                [*params, limite, offset],
            ).fetchall()
        return total, [dict(f) for f in filas]

    def ultimas(self, n: int) -> list[dict]:
        """Las últimas n lecturas de la sesión actual, en orden cronológico (para las gráficas)."""
        _, filas = self.lecturas(self.sesion["id"], limite=n)
        return filas[::-1]

    def iterar_lecturas(self, sesion_id: int):
        """Todas las lecturas de una sesión en orden cronológico, en bloques (para exportar CSV)."""
        ultimo = 0
        while True:
            with self._lock:
                filas = self._db.execute(
                    "SELECT * FROM lecturas WHERE sesion_id = ? AND id > ? ORDER BY id LIMIT 1000",
                    (sesion_id, ultimo),
                ).fetchall()
            if not filas:
                return
            for f in filas:
                yield dict(f)
            ultimo = filas[-1]["id"]

    def eventos(self, sesion_id: int, limite: int = 100) -> list[dict]:
        with self._lock:
            filas = self._db.execute("SELECT * FROM eventos WHERE sesion_id = ? ORDER BY id DESC LIMIT ?",
                                     (sesion_id, limite)).fetchall()
        return [dict(f) for f in filas]
