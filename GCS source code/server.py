# ==========================================================================
# Python GCS Server (server.py)
# Architecture: ThreadingTCPServer + Server-Sent Events (SSE)
# Thread safety: Python GIL covers simple attribute r/w. No explicit locks
# needed for our use pattern (one writer thread, multiple reader threads).
# ==========================================================================

import os
import json
import time
import math
import random
import threading
import urllib.request
import socketserver
from http.server import SimpleHTTPRequestHandler
import re
import sys
import sqlite3
import csv
from datetime import datetime
from pathlib import Path

# Optional serial support
try:
    import serial
    import serial.tools.list_ports
    SERIAL_AVAILABLE = True
except ImportError:
    SERIAL_AVAILABLE = False
    print("[WARN] pyserial not installed. Run: pip install pyserial")

PORT = 3000

# PyInstaller-aware path resolution:
# When frozen as .exe, bundled files (public/) are in sys._MEIPASS temp dir.
# Persistent files (data/) go next to the .exe itself.
if getattr(sys, 'frozen', False):
    # Running as bundled .exe
    BASE_DIR = sys._MEIPASS
    APP_DIR = os.path.dirname(sys.executable)
else:
    # Running as normal Python script
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    APP_DIR = BASE_DIR

PUBLIC_DIR = os.path.join(BASE_DIR, 'public')
LIBS_DIR = os.path.join(PUBLIC_DIR, 'libs')

OFFLINE_LIBS = [
    {"url": "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",        "filename": "leaflet.js"},
    {"url": "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",       "filename": "leaflet.css"},
    {"url": "https://cdn.jsdelivr.net/npm/chart.js",                   "filename": "chart.js"},
    {"url": "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js", "filename": "three.js"},
    {"url": "https://cdn.jsdelivr.net/npm/lucide@0.344.0/dist/umd/lucide.min.js", "filename": "lucide.js"}
]

os.makedirs(LIBS_DIR, exist_ok=True)

# Database configuration - always next to the executable for persistence
DATA_DIR = os.path.join(APP_DIR, 'data')
os.makedirs(DATA_DIR, exist_ok=True)
DB_FILE = os.path.join(DATA_DIR, 'telemetry.db')

# Telemetry format: TEAM_ID,TIME,PKT_COUNT,ALT,PRESSURE,TEMP,VOLT,LAT,LON,GPS_ALT,GPS_SATS,PITCH,YAW,ROLL,STATE,ERROR_CODE
TELEMETRY_PATTERN = re.compile(
    r'^(\d+),(\d+:\d+:\d+),(\d+),'  # Team ID, Time, Packet Count
    r'([-\d.]+),([-\d.]+),([-\d.]+),'  # Altitude, Pressure, Temperature
    r'([\d.]+),([-\d.]+),([-\d.]+),'  # Voltage, GPS Lat, GPS Lon
    r'([-\d.]+),(\d+),'  # GPS Altitude, GPS Satellites
    r'([-\d.]+),([-\d.]+),([-\d.]+),'  # Pitch, Yaw, Roll
    r'(\w+),'  # State
    r'(\d{4})$'  # Error Code (4 bits)
)

# ---------------------------------------------------------------------------
# 1. Automatic Library Downloader
# ---------------------------------------------------------------------------
def download_offline_assets():
    print("[BOOT] Checking offline library dependencies...")
    for lib in OFFLINE_LIBS:
        dest = os.path.join(LIBS_DIR, lib["filename"])
        if not os.path.exists(dest):
            print(f"[BOOT] Downloading: {lib['filename']}...")
            try:
                req = urllib.request.Request(
                    lib["url"],
                    headers={'User-Agent': 'Mozilla/5.0'}
                )
                with urllib.request.urlopen(req, timeout=15) as r:
                    with open(dest, 'wb') as f:
                        f.write(r.read())
                print(f"[BOOT] Saved: {lib['filename']}")
            except Exception as e:
                print(f"[BOOT_WARN] Could not download {lib['filename']}: {e}")
        else:
            print(f"[BOOT] Found cached: {lib['filename']}")

# ---------------------------------------------------------------------------
# 2. Serial Port Manager (Real Hardware + Validation)
# ---------------------------------------------------------------------------
class SerialManager:
    """Manages serial connection, reads telemetry, and validates packets."""
    
    def __init__(self):
        self.port = None
        self.baudrate = 9600
        self.timeout = 1.0
        self.connected = False
        self.connection_mode = "SIM"  # "SIM" or "HW"
        self.last_error = None
        self.packet_buffer = ""
        self.total_read = 0
        self.total_valid = 0
        self.total_invalid = 0

    @staticmethod
    def get_available_ports():
        """Detect available serial ports."""
        ports = []
        if not SERIAL_AVAILABLE:
            return ports
        
        try:
            for port_info in serial.tools.list_ports.comports():
                ports.append({
                    "device": port_info.device,
                    "description": port_info.description,
                    "hwid": port_info.hwid
                })
            print(f"[SERIAL] Found {len(ports)} serial port(s)")
        except Exception as e:
            print(f"[SERIAL_WARN] Failed to enumerate ports: {e}")
        
        return ports

    def connect(self, port_name, baudrate=9600):
        """Connect to a serial port."""
        if port_name == "SIM":
            self.connection_mode = "SIM"
            self.connected = False
            print("[SERIAL] Using SIMULATOR mode (no hardware)")
            return True

        if not SERIAL_AVAILABLE:
            print("[SERIAL_ERROR] pyserial not available. Cannot connect to hardware.")
            self.last_error = "pyserial not installed"
            return False

        try:
            self.port = serial.Serial(
                port=port_name,
                baudrate=baudrate,
                timeout=self.timeout,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                bytesize=serial.EIGHTBITS
            )
            self.connected = True
            self.connection_mode = "HW"
            print(f"[SERIAL] Connected to {port_name} @ {baudrate} baud")
            return True
        except serial.SerialException as e:
            self.connected = False
            self.connection_mode = "SIM"
            self.last_error = str(e)
            print(f"[SERIAL_ERROR] Failed to connect to {port_name}: {e}")
            return False

    def disconnect(self):
        """Close serial connection."""
        if self.port and self.connected:
            try:
                self.port.close()
                self.connected = False
                print("[SERIAL] Disconnected")
            except Exception as e:
                print(f"[SERIAL_WARN] Error closing port: {e}")

    def read_telemetry_packet(self):
        """Read and validate a telemetry packet from serial."""
        if not self.connected or not self.port:
            return None

        try:
            # Read until newline or timeout
            if self.port.in_waiting:
                byte = self.port.read(1)
                if byte:
                    char = byte.decode('utf-8', errors='ignore')
                    self.packet_buffer += char
                    
                    if char == '\n':
                        packet = self.packet_buffer.strip()
                        self.packet_buffer = ""
                        self.total_read += 1
                        
                        # Validate packet format
                        if self.validate_packet(packet):
                            self.total_valid += 1
                            return packet
                        else:
                            self.total_invalid += 1
                            print(f"[SERIAL_WARN] Invalid packet: {packet[:60]}...")
            
        except Exception as e:
            print(f"[SERIAL_ERROR] Read error: {e}")
            self.connected = False
        
        return None

    @staticmethod
    def validate_packet(packet):
        """Validate telemetry packet format and ranges."""
        if not packet or len(packet) < 50:
            return False
        
        # Check format
        if not TELEMETRY_PATTERN.match(packet):
            return False
        
        try:
            fields = packet.split(',')
            if len(fields) < 16:
                return False
            
            # Validate numeric ranges
            team_id = int(fields[0])
            pkt_count = int(fields[2])
            altitude = float(fields[3])
            pressure = float(fields[4])
            temp = float(fields[5])
            voltage = float(fields[6])
            sats = int(fields[10])
            
            # Sanity checks
            if not (0 <= altitude <= 50000):  # meters
                return False
            if not (50000 <= pressure <= 110000):  # Pa
                return False
            if not (-50 <= temp <= 85):  # Celsius
                return False
            if not (0 <= voltage <= 5):  # Volts
                return False
            if not (0 <= sats <= 32):  # GPS satellites
                return False
            
            return True
        except (ValueError, IndexError):
            return False

# Global serial manager
serial_mgr = SerialManager()

# ---------------------------------------------------------------------------
# 3. Telemetry Database (SQLite)
# ---------------------------------------------------------------------------
class TelemetryDatabase:
    """SQLite database for telemetry storage, export, and analysis."""
    
    def __init__(self, db_path):
        self.db_path = db_path
        self.lock = threading.Lock()
        self.init_database()
    
    def init_database(self):
        """Create database schema if it doesn't exist."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                
                # Telemetry packets table
                cursor.execute('''
                    CREATE TABLE IF NOT EXISTS telemetry (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        team_id INTEGER,
                        mission_time TEXT,
                        packet_count INTEGER,
                        altitude REAL,
                        pressure REAL,
                        temperature REAL,
                        voltage REAL,
                        gps_lat REAL,
                        gps_lon REAL,
                        gps_alt REAL,
                        gps_sats INTEGER,
                        pitch REAL,
                        yaw REAL,
                        roll REAL,
                        state TEXT,
                        error_code TEXT,
                        source TEXT DEFAULT 'SIM'
                    )
                ''')
                
                # Mission metadata table
                cursor.execute('''
                    CREATE TABLE IF NOT EXISTS missions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                        end_time DATETIME,
                        team_id INTEGER,
                        name TEXT,
                        packet_count INTEGER,
                        source TEXT,
                        notes TEXT
                    )
                ''')
                
                # Create indices for faster queries
                cursor.execute('CREATE INDEX IF NOT EXISTS idx_timestamp ON telemetry(timestamp)')
                cursor.execute('CREATE INDEX IF NOT EXISTS idx_packet_count ON telemetry(packet_count)')
                cursor.execute('CREATE INDEX IF NOT EXISTS idx_mission_id ON missions(start_time)')
                
                conn.commit()
                print(f"[DB] Database initialized: {self.db_path}")
        except Exception as e:
            print(f"[DB_ERROR] Failed to initialize database: {e}")
    
    def log_packet(self, packet_str, source='SIM'):
        """Store a telemetry packet in the database."""
        try:
            fields = packet_str.split(',')
            if len(fields) < 16:
                return False
            
            with self.lock:
                with sqlite3.connect(self.db_path) as conn:
                    cursor = conn.cursor()
                    cursor.execute('''
                        INSERT INTO telemetry 
                        (team_id, mission_time, packet_count, altitude, pressure, temperature,
                         voltage, gps_lat, gps_lon, gps_alt, gps_sats, pitch, yaw, roll,
                         state, error_code, source)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (
                        int(fields[0]),        # team_id
                        fields[1],             # mission_time
                        int(fields[2]),        # packet_count
                        float(fields[3]),      # altitude
                        float(fields[4]),      # pressure
                        float(fields[5]),      # temperature
                        float(fields[6]),      # voltage
                        float(fields[7]),      # gps_lat
                        float(fields[8]),      # gps_lon
                        float(fields[9]),      # gps_alt
                        int(fields[10]),       # gps_sats
                        float(fields[11]),     # pitch
                        float(fields[12]),     # yaw
                        float(fields[13]),     # roll
                        fields[14],            # state
                        fields[15].strip(),    # error_code
                        source                 # source (SIM or HW)
                    ))
                    conn.commit()
            return True
        except Exception as e:
            print(f"[DB_WARN] Failed to log packet: {e}")
            return False
    
    def export_csv(self, output_file=None):
        """Export all telemetry data to CSV."""
        try:
            if output_file is None:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                output_file = os.path.join(DATA_DIR, f"telemetry_export_{timestamp}.csv")
            
            with self.lock:
                with sqlite3.connect(self.db_path) as conn:
                    cursor = conn.cursor()
                    cursor.execute('SELECT * FROM telemetry ORDER BY id')
                    rows = cursor.fetchall()
                    
                    # Get column names
                    cursor.execute("PRAGMA table_info(telemetry)")
                    columns = [col[1] for col in cursor.fetchall()]
            
            if not rows:
                print(f"[DB] No data to export")
                return None
            
            with open(output_file, 'w', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(columns)
                writer.writerows(rows)
            
            print(f"[DB] Exported {len(rows)} packets to: {output_file}")
            return output_file
        except Exception as e:
            print(f"[DB_ERROR] Failed to export CSV: {e}")
            return None
    
    def get_statistics(self):
        """Get telemetry statistics."""
        try:
            with self.lock:
                with sqlite3.connect(self.db_path) as conn:
                    cursor = conn.cursor()
                    
                    # Total packets
                    cursor.execute('SELECT COUNT(*) FROM telemetry')
                    total = cursor.fetchone()[0]
                    
                    # Altitude stats
                    cursor.execute('SELECT MIN(altitude), MAX(altitude), AVG(altitude) FROM telemetry')
                    alt_min, alt_max, alt_avg = cursor.fetchone()
                    
                    # Temperature stats
                    cursor.execute('SELECT MIN(temperature), MAX(temperature), AVG(temperature) FROM telemetry')
                    temp_min, temp_max, temp_avg = cursor.fetchone()
                    
                    # Voltage stats
                    cursor.execute('SELECT MIN(voltage), MAX(voltage) FROM telemetry')
                    volt_min, volt_max = cursor.fetchone()
                    
                    # Flight states
                    cursor.execute('SELECT state, COUNT(*) as count FROM telemetry GROUP BY state')
                    states = {row[0]: row[1] for row in cursor.fetchall()}
                    
                    # Source distribution
                    cursor.execute('SELECT source, COUNT(*) as count FROM telemetry GROUP BY source')
                    sources = {row[0]: row[1] for row in cursor.fetchall()}
            
            return {
                "total_packets": total,
                "altitude": {
                    "min": alt_min,
                    "max": alt_max,
                    "avg": alt_avg
                },
                "temperature": {
                    "min": temp_min,
                    "max": temp_max,
                    "avg": temp_avg
                },
                "voltage": {
                    "min": volt_min,
                    "max": volt_max
                },
                "states": states,
                "sources": sources
            }
        except Exception as e:
            print(f"[DB_ERROR] Failed to get statistics: {e}")
            return {}
    
    def get_flight_data(self, limit=100, offset=0):
        """Retrieve flight data for playback or analysis."""
        try:
            with self.lock:
                with sqlite3.connect(self.db_path) as conn:
                    conn.row_factory = sqlite3.Row
                    cursor = conn.cursor()
                    
                    cursor.execute('''
                        SELECT * FROM telemetry
                        ORDER BY id DESC
                        LIMIT ? OFFSET ?
                    ''', (limit, offset))
                    
                    rows = cursor.fetchall()
                    return [dict(row) for row in rows]
        except Exception as e:
            print(f"[DB_ERROR] Failed to retrieve flight data: {e}")
            return []
    
    def clear_data(self):
        """Clear all telemetry data (destructive operation)."""
        try:
            with self.lock:
                with sqlite3.connect(self.db_path) as conn:
                    cursor = conn.cursor()
                    cursor.execute('DELETE FROM telemetry')
                    cursor.execute('DELETE FROM missions')
                    conn.commit()
            print("[DB] All telemetry data cleared")
            return True
        except Exception as e:
            print(f"[DB_ERROR] Failed to clear data: {e}")
            return False

# Global database instance
db = TelemetryDatabase(DB_FILE)

# ---------------------------------------------------------------------------
# 4. Flight Simulator  (single writer thread — no locks needed)
# ---------------------------------------------------------------------------
class CanSatSimulator:
    def __init__(self):
        self.active          = False
        self.speed           = 1.0
        # feedback queue — list is GIL-safe for append/pop in CPython
        self.feedbacks       = []
        # new-packet event — SSE threads wait on this
        self.new_packet      = threading.Event()
        self.source_mode     = "SIM"  # "SIM" or "HW"
        self._reset_fields()

    # ---- internal field reset (called only from writer or __init__) -------
    def _reset_fields(self):
        self.packet_count    = 0
        self.sim_time        = 0
        self.state           = "STANDBY"
        self.altitude        = 0.0
        self.velocity        = 0.0
        self.pressure        = 101325.0
        self.temperature     = 25.0
        self.voltage         = 4.20
        self.gps_lat         = 28.628920
        self.gps_lon         = 77.215010
        self.gps_alt         = 216.0
        self.gps_sats        = 10
        self.roll            = 0.0
        self.pitch           = 0.0
        self.yaw             = 0.0
        self.max_alt         = 750.0
        self.ascent_dur      = 25
        self.separated       = False
        self.chute           = False
        self.redundant       = False
        self.f_descent       = False
        self.f_gps           = False
        self.f_separation    = False
        self.f_parachute     = False
        self.latest_packet   = ""

    def reset(self):
        self.active = False
        self._reset_fields()

    def start(self):
        if self.state == "STANDBY":
            self.state = "ASCENT"
        self.active = True

    def stop(self):
        self.active = False

    def clear_all_faults(self):
        self.f_descent    = False
        self.f_gps        = False
        self.f_separation = False
        self.f_parachute  = False

    def send_command(self, code):
        if code == "CMD_SEPARATION":
            if self.f_separation:
                self.feedbacks.append({"text": "ERROR: Separation pyros failed!", "type": "danger"})
            else:
                self.separated = True
                self.feedbacks.append({"text": "SUCCESS: Separation pyros fired. Payload deployed.", "type": "success"})
        elif code == "CMD_PARACHUTE":
            self.chute = True
            self.f_parachute = True
            self.feedbacks.append({"text": "SUCCESS: Emergency parachute deployed!", "type": "success"})
        elif code == "CMD_REDUNDANT":
            self.redundant = True
            self.feedbacks.append({"text": "SUCCESS: Redundant backup activation fired.", "type": "success"})

    def parse_hardware_packet(self, raw_packet):
        """Parse telemetry from hardware and update simulator state (for display)."""
        try:
            fields = raw_packet.split(",")
            if len(fields) < 16:
                return False
            
            self.packet_count      = int(fields[2])
            self.altitude          = float(fields[3])
            self.pressure          = float(fields[4])
            self.temperature       = float(fields[5])
            self.voltage           = float(fields[6])
            self.gps_lat           = float(fields[7])
            self.gps_lon           = float(fields[8])
            self.gps_alt           = float(fields[9])
            self.gps_sats          = int(fields[10])
            self.pitch             = float(fields[11])
            self.yaw               = float(fields[12])
            self.roll              = float(fields[13])
            self.state             = fields[14]
            error_code             = fields[15].strip()
            
            # Parse error code (4 bits)
            if len(error_code) >= 4:
                self.f_descent    = error_code[0] == "1"
                self.f_gps        = error_code[1] == "1"
                self.f_separation = error_code[2] == "1"
                self.f_parachute  = error_code[3] == "1"
            
            self.latest_packet = raw_packet
            self.new_packet.set()
            self.new_packet.clear()
            return True
        except (ValueError, IndexError) as e:
            print(f"[SIM] Failed to parse hardware packet: {e}")
            return False

    # ---- called by background thread every 1/speed seconds ----------------
    def tick(self):
        if not self.active:
            return

        noise = lambda: (random.random() - 0.5) * 5

        self.sim_time     += 1
        self.packet_count += 1
        self.voltage       = max(3.30, self.voltage - 0.002)

        # --- State machine ---
        if self.state == "ASCENT":
            p = min(1.0, self.sim_time / self.ascent_dur)
            self.altitude     = self.max_alt * math.sin(p * math.pi / 2)
            self.velocity     = (self.max_alt * math.pi / (2 * self.ascent_dur)) * math.cos(p * math.pi / 2)
            self.roll         = (self.roll + 15 + noise()) % 360
            self.pitch        = noise()
            self.yaw          = (self.yaw + 2 + noise()) % 360
            self.temperature  = 25.0 - self.altitude * 0.0065
            self.pressure     = 101325.0 * math.pow(1 - 2.25577e-5 * self.altitude, 5.25588)
            self.gps_alt      = 216.0 + self.altitude
            if p >= 1.0:
                self.state = "APEX"

        elif self.state == "APEX":
            self.altitude = self.max_alt
            if not self.f_separation:
                self.separated = True
            self.state = "DESCENT"

        elif self.state == "DESCENT":
            self.roll  = (self.roll + 3 + noise()) % 360
            self.pitch = 10 + noise()
            self.yaw   = (self.yaw + 1 + noise()) % 360
            if not self.f_gps:
                self.gps_lat += 0.00002
                self.gps_lon += 0.000035
            fall = 14.5
            if self.chute or (self.altitude < 600.0 and not self.f_separation):
                self.chute = True
                fall = 9.0
            if self.f_descent:
                fall = 16.5
            self.velocity    = -fall + (random.random() - 0.5) * 0.4
            self.altitude    = max(0.0, self.altitude + self.velocity)
            self.temperature = 25.0 - self.altitude * 0.0065
            self.pressure    = 101325.0 * math.pow(1 - 2.25577e-5 * self.altitude, 5.25588)
            self.gps_alt     = 216.0 + self.altitude
            if self.altitude <= 0.0:
                self.velocity = 0.0
                self.state = "LANDED"

        elif self.state == "LANDED":
            self.velocity    = 0.0
            self.roll        = noise()
            self.pitch       = noise()
            self.temperature = 25.0 + noise() * 0.1
            self.pressure    = 101325.0 + noise() * 2
            self.gps_alt     = 216.0

        self.gps_sats = random.randint(0, 2) if self.f_gps else 9 + random.randint(0, 3)

        # --- Error code ---
        rate = abs(self.velocity)
        d1 = "1" if (self.state == "DESCENT" and (rate < 8.0 or rate > 10.0)) or self.f_descent else "0"
        d2 = "0" if self.gps_sats >= 4 and not self.f_gps else "1"
        d3 = "1" if (self.state in ["DESCENT","LANDED"] and not self.separated) or self.f_separation else "0"
        d4 = "1" if self.f_parachute else "0"

        h = str(int(self.sim_time // 3600)).zfill(2)
        m = str(int((self.sim_time % 3600) // 60)).zfill(2)
        s = str(int(self.sim_time % 60)).zfill(2)

        self.latest_packet = ",".join([
            "2026", f"{h}:{m}:{s}", str(self.packet_count),
            f"{self.altitude:.1f}", f"{self.pressure:.0f}", f"{self.temperature:.1f}",
            f"{self.voltage:.2f}", f"{self.gps_lat:.6f}", f"{self.gps_lon:.6f}",
            f"{self.gps_alt:.1f}", str(self.gps_sats), f"{self.pitch:.1f}",
            f"{self.yaw:.1f}", f"{self.roll:.1f}", self.state, f"{d1}{d2}{d3}{d4}"
        ])

        # Signal all SSE threads that a new packet is ready
        self.new_packet.set()
        self.new_packet.clear()


# Global simulator
sim = CanSatSimulator()

# Background data source loop (handles both simulator and hardware)
def data_source_loop():
    """Main loop that reads from either simulator or hardware serial port."""
    while True:
        if sim.source_mode == "HW" and serial_mgr.connected:
            # Try to read from hardware
            packet = serial_mgr.read_telemetry_packet()
            if packet:
                sim.parse_hardware_packet(packet)
                db.log_packet(packet, source='HW')
            else:
                time.sleep(0.01)  # Small delay if no data
        else:
            # Run simulator
            sim.tick()
            if sim.active and sim.latest_packet:
                db.log_packet(sim.latest_packet, source='SIM')
            time.sleep(1.0 / max(0.1, sim.speed))

threading.Thread(target=data_source_loop, daemon=True).start()

# ---------------------------------------------------------------------------
# 3. HTTP + SSE Handler
# ---------------------------------------------------------------------------
class GCSHandler(SimpleHTTPRequestHandler):

    def translate_path(self, path):
        path = path.split('?', 1)[0].split('#', 1)[0]
        rel  = os.path.relpath(path, '/')
        return os.path.join(PUBLIC_DIR, rel)

    def log_message(self, fmt, *args):
        # Suppress noisy per-request logs (only show errors)
        if args and len(args) >= 3 and str(args[1]) not in ('200', '304'):
            super().log_message(fmt, *args)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/stream'):
            self._sse_stream()
        elif self.path.startswith('/ports'):
            self._get_ports()
        elif self.path.startswith('/stats'):
            self._get_stats()
        elif self.path.startswith('/data/flight'):
            self._get_flight_data()
        elif self.path.startswith('/export/csv'):
            self._export_csv_file()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith('/command'):
            length   = int(self.headers.get('Content-Length', 0))
            raw      = self.rfile.read(length)
            try:
                self._handle_command(json.loads(raw))
            except Exception as e:
                self._json_response({"status": "error", "detail": str(e)}, 400)
        else:
            self.send_error(404)

    # ---- SSE telemetry stream ---------------------------------------------
    def _sse_stream(self):
        self.send_response(200)
        self.send_header('Content-Type',  'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection',    'keep-alive')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        print(f"[SSE] Client connected: {self.client_address[0]}")
        last_count = -1

        try:
            while True:
                # Drain any pending feedback messages first
                while sim.feedbacks:
                    fb  = sim.feedbacks.pop(0)
                    msg = json.dumps({"type": "control_feedback",
                                      "text": fb["text"],
                                      "statusType": fb["type"]})
                    self.wfile.write(f"data: {msg}\n\n".encode())
                    self.wfile.flush()

                # Send new telemetry packet if available
                if sim.packet_count != last_count and sim.latest_packet:
                    last_count = sim.packet_count
                    msg = json.dumps({"type": "telemetry", "data": sim.latest_packet})
                    self.wfile.write(f"data: {msg}\n\n".encode())
                    self.wfile.flush()

                # Wait up to 200ms for next packet (keeps CPU load minimal)
                sim.new_packet.wait(timeout=0.2)

        except (BrokenPipeError, ConnectionResetError, OSError):
            print(f"[SSE] Client disconnected: {self.client_address[0]}")

    # ---- GET /ports -------------------------------------------------------
    def _get_ports(self):
        """List available serial ports and current connection status."""
        ports = []
        try:
            available = serial_mgr.get_available_ports()
            ports = [{"device": p["device"], "description": p["description"]} for p in available]
        except Exception as e:
            print(f"[HTTP] Error getting ports: {e}")
        
        response = {
            "ports": ports,
            "current_mode": serial_mgr.connection_mode,
            "connected": serial_mgr.connected,
            "stats": {
                "total_read": serial_mgr.total_read,
                "total_valid": serial_mgr.total_valid,
                "total_invalid": serial_mgr.total_invalid
            }
        }
        self._json_response(response)

    # ---- GET /stats -------------------------------------------------------
    def _get_stats(self):
        """Get telemetry statistics from database."""
        stats = db.get_statistics()
        self._json_response(stats)

    # ---- GET /data/flight -------------------------------------------------
    def _get_flight_data(self):
        """Get historical flight data (for playback or analysis)."""
        try:
            limit = int(self.path.split('limit=')[-1].split('&')[0]) if 'limit=' in self.path else 100
            offset = int(self.path.split('offset=')[-1]) if 'offset=' in self.path else 0
            limit = max(1, min(limit, 1000))  # Clamp between 1-1000
            offset = max(0, offset)
        except:
            limit = 100
            offset = 0
        
        data = db.get_flight_data(limit=limit, offset=offset)
        self._json_response({"data": data, "count": len(data)})

    # ---- GET /export/csv --------------------------------------------------
    def _export_csv_file(self):
        """Export telemetry to CSV and serve for download."""
        try:
            csv_file = db.export_csv()
            if not csv_file or not os.path.exists(csv_file):
                self._json_response({"error": "Export failed"}, 400)
                return
            
            # Read and serve CSV file
            with open(csv_file, 'r') as f:
                content = f.read()
            
            filename = os.path.basename(csv_file)
            self.send_response(200)
            self.send_header('Content-Type', 'text/csv')
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(content.encode())
        except Exception as e:
            print(f"[HTTP_ERROR] CSV export failed: {e}")
            self._json_response({"error": str(e)}, 500)

    # ---- POST /command ----------------------------------------------------
    def _handle_command(self, obj):
        cmd = obj.get("cmd", "")

        if cmd == "CONNECT_PORT":
            port = obj.get("port", "SIM")
            baudrate = obj.get("baudrate", 9600)
            
            # Disconnect any existing connection
            if serial_mgr.connected:
                serial_mgr.disconnect()
            
            # Try to connect
            success = serial_mgr.connect(port, baudrate)
            
            if port == "SIM":
                sim.source_mode = "SIM"
                sim.feedbacks.append({"text": "Switched to SIMULATOR mode", "type": "info"})
                self._json_response({
                    "type": "status",
                    "message": "CONNECTED_SIM",
                    "port": port,
                    "success": True
                })
            elif success:
                sim.source_mode = "HW"
                sim.feedbacks.append({"text": f"Connected to hardware: {port}", "type": "success"})
                self._json_response({
                    "type": "status",
                    "message": "CONNECTED_HW",
                    "port": port,
                    "success": True
                })
            else:
                # Fall back to simulator
                sim.source_mode = "SIM"
                error_msg = serial_mgr.last_error or "Unknown error"
                sim.feedbacks.append({
                    "text": f"Failed to connect to {port}: {error_msg}. Falling back to simulator.",
                    "type": "danger"
                })
                self._json_response({
                    "type": "status",
                    "message": "CONNECTED_SIM",
                    "port": "SIM",
                    "success": False,
                    "error": error_msg
                })

        elif cmd == "START_STREAM":
            sim.start()
            self._json_response({"status": "started"})

        elif cmd == "STOP_STREAM":
            sim.stop()
            self._json_response({"status": "stopped"})

        elif cmd == "RESET_FLIGHT":
            sim.reset()
            sim.feedbacks.append({"text": "SIM: Flight reset to launch configuration.", "type": "info"})
            self._json_response({"status": "reset"})

        elif cmd == "SET_SPEED":
            sim.speed = max(0.1, float(obj.get("value", 1)))
            self._json_response({"status": "speed_set"})

        elif cmd == "SYNC_TIME":
            self._json_response({"status": "synced"})

        elif cmd == "FAULT_INJECT":
            fault = obj.get("fault", "")
            if fault == "DESCENT":    sim.f_descent    = True
            elif fault == "GPS":      sim.f_gps        = True
            elif fault == "SEPARATION": sim.f_separation = True
            elif fault == "PARACHUTE":  sim.f_parachute  = True
            sim.feedbacks.append({"text": f"FAULT INJECTED: {fault}", "type": "warning"})
            self._json_response({"status": "fault_injected"})

        elif cmd == "FAULT_CLEAR":
            fault = obj.get("fault", "")
            if fault == "DESCENT":    sim.f_descent    = False
            elif fault == "GPS":      sim.f_gps        = False
            elif fault == "SEPARATION": sim.f_separation = False
            elif fault == "PARACHUTE":  sim.f_parachute  = False
            sim.feedbacks.append({"text": f"FAULT CLEARED: {fault}", "type": "success"})
            self._json_response({"status": "fault_cleared"})

        elif cmd == "FAULT_CLEAR_ALL":
            sim.clear_all_faults()
            sim.feedbacks.append({"text": "All faults cleared.", "type": "success"})
            self._json_response({"status": "faults_cleared"})

        elif cmd == "UPLINK_COMMAND":
            sim.send_command(obj.get("code", ""))
            self._json_response({"status": "command_transmitted"})

        elif cmd == "DISCONNECT":
            serial_mgr.disconnect()
            sim.source_mode = "SIM"
            sim.feedbacks.append({"text": "Disconnected from hardware. Switched to simulator.", "type": "info"})
            self._json_response({"status": "disconnected"})

        elif cmd == "EXPORT_CSV":
            csv_file = db.export_csv()
            if csv_file:
                self._json_response({
                    "status": "exported",
                    "file": os.path.basename(csv_file),
                    "url": f"/export/csv?file={os.path.basename(csv_file)}"
                })
            else:
                self._json_response({"status": "export_failed"}, 400)

        elif cmd == "GET_STATS":
            stats = db.get_statistics()
            self._json_response({"status": "ok", "data": stats})

        elif cmd == "CLEAR_DATA":
            db.clear_data()
            sim.feedbacks.append({"text": "All telemetry data cleared from database.", "type": "warning"})
            self._json_response({"status": "cleared"})

        else:
            self._json_response({"status": "unknown_cmd"})

    # ---- helper -----------------------------------------------------------
    def _json_response(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type',               'application/json')
        self.send_header('Content-Length',              str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

# ---------------------------------------------------------------------------
# 4. Main
# ---------------------------------------------------------------------------
def main():
    download_offline_assets()

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), GCSHandler) as httpd:
        print(f"\n{'='*60}")
        print(f"  CANSAT GCS SERVER  ->  http://localhost:{PORT}")
        print(f"{'='*60}\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[SHUTDOWN] GCS server stopped.")

if __name__ == "__main__":
    main()
