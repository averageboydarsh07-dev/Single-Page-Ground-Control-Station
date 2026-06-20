# CanSat GCS - Serial Communication Configuration

## Overview
The GCS backend now supports **real serial hardware** communication alongside the built-in simulator. The system auto-detects serial ports and validates all incoming telemetry.

## Installation

### For Hardware Support
Install `pyserial`:
```bash
pip install pyserial
```

Without it, the GCS will still work in **simulator mode only**.

## Telemetry Protocol

### Packet Format (CSV)
```
TEAM_ID,TIME,PKT_COUNT,ALT,PRESSURE,TEMP,VOLT,LAT,LON,GPS_ALT,GPS_SATS,PITCH,YAW,ROLL,STATE,ERROR_CODE
```

### Example Packet
```
2026,12:34:56,0042,450.5,101325,22.5,4.15,28.628920,77.215010,666.5,10,2.3,1.5,5.2,DESCENT,0010
```

### Field Descriptions

| Field | Format | Example | Notes |
|-------|--------|---------|-------|
| TEAM_ID | Integer | 2026 | Your CanSat team ID |
| TIME | HH:MM:SS | 12:34:56 | Mission elapsed time |
| PKT_COUNT | Integer | 0042 | Packet sequence number |
| ALT | Float | 450.5 | Altitude in meters |
| PRESSURE | Float | 101325 | Atmospheric pressure in Pa |
| TEMP | Float | 22.5 | Temperature in °C |
| VOLT | Float | 4.15 | Battery voltage in V |
| LAT | Float | 28.628920 | GPS latitude (decimal) |
| LON | Float | 77.215010 | GPS longitude (decimal) |
| GPS_ALT | Float | 666.5 | GPS altitude in meters |
| GPS_SATS | Integer | 10 | Number of GPS satellites |
| PITCH | Float | 2.3 | Pitch angle in degrees |
| YAW | Float | 1.5 | Yaw angle in degrees |
| ROLL | Float | 5.2 | Roll angle in degrees |
| STATE | String | DESCENT | Flight state: STANDBY, ASCENT, APEX, DESCENT, LANDED |
| ERROR_CODE | 4-bit | 0010 | Fault bits: [Descent, GPS, Separation, Parachute] |

### Serial Port Settings
```
Baud Rate:  9600 bps
Data Bits:  8
Stop Bits:  1
Parity:     None
Handshake:  None
Timeout:    1.0 second
```

## Validation Rules

The GCS validates **all incoming packets** before accepting them:

### Format Validation
- Exact CSV format required
- Must contain all 16 fields
- Proper delimiters (commas)

### Range Validation
| Field | Min | Max | Unit |
|-------|-----|-----|------|
| Altitude | 0 | 50,000 | m |
| Pressure | 50,000 | 110,000 | Pa |
| Temperature | -50 | 85 | °C |
| Voltage | 0 | 5 | V |
| GPS Satellites | 0 | 32 | count |
| Latitude | -90 | 90 | degrees |
| Longitude | -180 | 180 | degrees |

Invalid packets are **discarded** and logged.

## Usage

### 1. Connect to Simulator (Default)
```
Port: SIM
Mode: Simulator
No hardware needed
```

### 2. Connect to Hardware
In GCS UI:
1. Click **[Connect]** button
2. Select your COM port from dropdown
3. Click **Connect**
4. Dashboard will show "CONNECTED (COM3)" or similar

### Fallback Behavior
If connection fails, the GCS **automatically falls back to simulator** with an error message.

## Debug Statistics

The `/ports` endpoint returns connection stats:
```json
{
  "stats": {
    "total_read": 1024,
    "total_valid": 1020,
    "total_invalid": 4
  }
}
```

## Troubleshooting

### Port Not Detected
```
[WARN] pyserial not installed. Run: pip install pyserial
```
**Solution:** `pip install pyserial`

### Connection Failed
```
[SERIAL_ERROR] Failed to connect to COM3: Access denied
```
**Solutions:**
- Port is in use by another application → Close it
- Wrong baud rate → Verify hardware settings
- Driver missing → Install CH340 or CP2102 drivers

### Invalid Packets
```
[SERIAL_WARN] Invalid packet: 2026,12:34:56...
```
**Causes:**
- Corrupted data on serial line → Check cable
- Incorrect format → Verify payload firmware
- Out-of-range values → Check sensor calibration

## Hardware Integration Example

Python code to send telemetry to GCS:

```python
import serial
import time

ser = serial.Serial('COM3', 9600, timeout=1)

team_id = 2026
pkt_count = 0
state = "ASCENT"

while True:
    # Read sensor data from your CanSat
    altitude = 450.5
    pressure = 101325.0
    temp = 22.5
    voltage = 4.15
    lat = 28.628920
    lon = 77.215010
    gps_alt = 666.5
    sats = 10
    pitch = 2.3
    yaw = 1.5
    roll = 5.2
    error_code = "0000"
    
    time_str = "12:34:56"  # From your RTC
    
    packet = f"{team_id},{time_str},{pkt_count},{altitude},{pressure},{temp}," \
             f"{voltage},{lat},{lon},{gps_alt},{sats},{pitch},{yaw},{roll}," \
             f"{state},{error_code}\n"
    
    ser.write(packet.encode())
    pkt_count += 1
    time.sleep(1.0)

ser.close()
```

## Statistics & Monitoring

View real-time connection statistics:
```
GET /ports
```

Response includes:
- Available ports with descriptions
- Current connection mode (SIM/HW)
- Connection state
- Packet validation stats

## Commands

New serial-related commands:

| Command | Purpose |
|---------|---------|
| `CONNECT_PORT` | Connect to COM port or switch to SIM |
| `DISCONNECT` | Close hardware connection, switch to SIM |

## Future Enhancements

- [ ] Configurable baud rates per payload
- [ ] CRC/checksum validation
- [ ] Automatic baud rate detection
- [ ] Binary protocol support
- [ ] Bidirectional commands via serial
