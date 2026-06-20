# CanSat GCS - Backend Serial Communication Implementation

## ✅ What Was Fixed

### Critical Issue #1: Backend Serial Communication
The GCS now has **full hardware telemetry support** with validation, error handling, and fallback mechanisms.

---

## 📋 Improvements Made

### 1. **Real Serial Port Detection** ✅
- Automatically scans available COM ports
- Returns port descriptions and hardware IDs
- Falls back to simulator if no ports available

```python
GET /ports
# Response includes available ports, current mode, and packet stats
```

### 2. **Serial Connection Manager** ✅
- `SerialManager` class handles all hardware I/O
- Auto-connects with error handling
- Connection state tracking
- Automatic fallback to simulator on failure

```python
Connect → Hardware mode
Failed → Fallback to Simulator automatically
```

### 3. **Telemetry Validation** ✅
- **Format validation**: Regex pattern matching for CSV structure
- **Range validation**: Checks altitude, pressure, temperature, voltage, satellites
- **Packet statistics**: Tracks read/valid/invalid counts

Invalid packets are discarded with logging:
```
[SERIAL_WARN] Invalid packet: 2026,12:34:56...
```

### 4. **Dual Data Source** ✅
- Single unified `data_source_loop()` handles both:
  - **SIM mode**: Built-in physics simulator
  - **HW mode**: Real hardware telemetry via serial
- Seamless switching without restarting

### 5. **Hardware Packet Parsing** ✅
- Added `parse_hardware_packet()` method
- Parses CSV telemetry into simulator state
- Auto-updates UI with real telemetry
- Error code bit parsing

### 6. **Connection Commands** ✅
New commands for connection management:

| Command | Payload | Purpose |
|---------|---------|---------|
| `CONNECT_PORT` | `{port: "COM3", baudrate: 9600}` | Connect to hardware |
| `DISCONNECT` | `{}` | Close connection, fallback to SIM |

### 7. **Error Handling** ✅
- Serial port errors handled gracefully
- Network errors caught
- Malformed packets ignored
- Connection failures → Auto-fallback to simulator

---

## 🔧 Installation

### Install Serial Support (Optional)
```bash
pip install pyserial
```

**Without it:** GCS works in simulator mode only.

---

## 📡 Telemetry Protocol

Your CanSat payload should transmit **CSV packets** via serial:

```
TEAM_ID,TIME,PKT_COUNT,ALT,PRESSURE,TEMP,VOLT,LAT,LON,GPS_ALT,GPS_SATS,PITCH,YAW,ROLL,STATE,ERROR_CODE
```

**Example:**
```
2026,12:34:56,0042,450.5,101325,22.5,4.15,28.628920,77.215010,666.5,10,2.3,1.5,5.2,DESCENT,0010
```

**Every packet must:**
- Be 16 comma-separated fields
- End with `\n` (newline)
- Have values in valid ranges (see SERIAL_CONFIG.md)

---

## 🚀 Usage

### 1. **Start GCS**
```bash
python server.py
# or
launch.bat
```

### 2. **Connect to Simulator (Default)**
UI automatically starts in simulator mode
- No hardware needed
- Full telemetry simulation

### 3. **Connect to Hardware**
1. Click **[Connect]** in GCS UI
2. Select your COM port from dropdown
3. Click **Connect**
4. Dashboard shows "CONNECTED (COM3)" or similar

### 4. **Hardware Falls Back to Simulator**
If connection fails:
- Dashboard shows error message
- Automatically switches to simulator
- No data loss

---

## 📊 Validation Rules

### Format
- Must be CSV with 16 fields
- Fields in exact order
- Proper delimiters (commas)

### Value Ranges
| Field | Min | Max |
|-------|-----|-----|
| Altitude | 0 | 50,000 m |
| Pressure | 50,000 | 110,000 Pa |
| Temperature | -50 | 85 °C |
| Voltage | 0 | 5 V |
| GPS Sats | 0 | 32 |

### Error Code (4-bit)
```
Bit 0: Descent rate fault
Bit 1: GPS loss
Bit 2: Separation failure
Bit 3: Parachute deployment
```

Example: `0010` = GPS lost

---

## 🔍 Debugging

### Check Available Ports
```bash
# In Python
import serial.tools.list_ports
for p in serial.tools.list_ports.comports():
    print(f"{p.device}: {p.description}")
```

### Monitor Serial Data (optional)
```bash
# Using a serial monitor tool
baudrate: 9600
data bits: 8
stop bits: 1
parity: none
```

### View Statistics
GCS tracks packet statistics:
```json
{
  "stats": {
    "total_read": 1024,
    "total_valid": 1020,
    "total_invalid": 4
  }
}
```

---

## 📝 Full Protocol Documentation

See **SERIAL_CONFIG.md** for:
- Complete field descriptions
- Hardware integration example (Python code)
- Troubleshooting guide
- Future enhancements

---

## ✨ Code Changes Summary

### Files Modified
1. **server.py**: Added SerialManager, validation, dual data source
2. **package.json**: Updated with Python dependencies

### Files Created
1. **SERIAL_CONFIG.md**: Complete protocol documentation
2. **SERIAL_IMPLEMENTATION.md**: This file

### Key Classes
- `SerialManager`: Handles port detection, connection, reading, validation
- `CanSatSimulator`: Enhanced with hardware packet parsing

### Key Methods
- `serial_mgr.get_available_ports()`: Detect COM ports
- `serial_mgr.connect()`: Connect to hardware
- `serial_mgr.read_telemetry_packet()`: Read validated packet
- `sim.parse_hardware_packet()`: Parse hardware data into UI

---

## 🎯 Next Steps

To use with real hardware:

1. **Install pyserial**: `pip install pyserial`
2. **Connect CanSat**: Via USB/serial adapter
3. **Start GCS**: `python server.py`
4. **Connect in UI**: Select COM port and click Connect
5. **View Telemetry**: Dashboard updates in real-time

---

## ⚠️ Known Limitations

- No CRC/checksum validation (add as enhancement)
- Fixed baud rate (9600 configurable in code)
- CSV format only (binary protocol as future work)
- No command uplink via serial (read-only for now)

---

## 📞 Support

For issues:
1. Check SERIAL_CONFIG.md Troubleshooting section
2. Verify payload format matches protocol
3. Check serial monitor for data transmission
4. Review GCS console logs for validation errors

---

**✅ Critical Issue #1 RESOLVED: Backend serial communication is now fully implemented with validation and fallback mechanisms.**
