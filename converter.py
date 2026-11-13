"""Format one IBTrACS storm as a Delft3D track."""
import csv
import io
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

FIELDS = ("NAME", "ISO_TIME", "LAT", "LON", "WMO_WIND", "WMO_PRES")
POSITIONS = (5, 6, 8, 9, 10, 11)
MISSING = {"", "NA", "N/A", "NAN", "NULL", "-9999", "9999"}
MONTHS = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split()


def timestamp(value):
    if value.upper() in MISSING:
        return None
    value = re.sub(r"([ T])(\d):", r"\g<1>0\2:", value)
    time = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if time.tzinfo:
        time = time.astimezone(timezone.utc)
    if time.minute or time.second or time.microsecond:
        raise ValueError("TIME must fall on a whole UTC hour.")
    return time


def period(times):
    if not times:
        return "9999"
    start, end = min(times), max(times)
    last = f"{end.day} {MONTHS[end.month-1]} {end.year}"
    if start == end:
        return last
    first = str(start.day)
    if (start.year, start.month) != (end.year, end.month):
        first += " " + MONTHS[start.month-1]
    if start.year != end.year:
        first += f" {start.year}"
    return first + "-" + last


def number(value, places):
    if value.upper() in MISSING:
        return "9999"
    n = Decimal(value)
    if not n.is_finite():
        raise ValueError("Expected a finite number.")
    if n in (-9999, 9999):
        return "9999"
    if places == 0 and n != n.to_integral_value():
        raise ValueError("WIND and PR must be whole numbers.")
    return format(n, f".{places}f")


def convert(source):
    rows = csv.reader(io.StringIO(source.lstrip("\ufeff")), strict=True)
    indices = None
    names, ids, dates, records = set(), set(), [], []
    for row in rows:
        row = [cell.strip() for cell in row]
        if not any(row):
            continue
        if indices is None:
            header = [cell.upper() for cell in row]
            if set(header).intersection(FIELDS):
                missing = set(FIELDS).difference(header)
                if missing:
                    raise ValueError("Missing columns: " + ", ".join(sorted(missing)))
                indices = [header.index(field) for field in FIELDS]
                sid = header.index("SID") if "SID" in header else None
                continue
            indices, sid = POSITIONS, 0
        def cell(index):
            return row[index] if index < len(row) else ""
        name, raw_time, lat, lon, wind, pressure = map(cell, indices)
        if lat.lower() == "degrees_north" and lon.lower() == "degrees_east":
            continue
        if name.upper() not in MISSING:
            names.add(name.upper())
        if sid is not None and cell(sid):
            ids.add(cell(sid))
        if len(names) > 1 or len(ids) > 1:
            raise ValueError("Select a CSV containing a single storm.")
        try:
            time = timestamp(raw_time)
            if time:
                dates.append(time.date())
            clock = time.strftime("%m/%d/%HZ") if time else "9999"
            adv = len(records) + 1
            records.append(f"{adv:3} {number(lat, 2):>6} {number(lon, 2):>7} {clock:>9} {number(wind, 0):>4} {number(pressure, 0):>5}")
        except (ValueError, InvalidOperation) as error:
            raise ValueError(f"CSV line {rows.line_num}: {error}") from error
    if not records:
        raise ValueError("No track records found.")
    return "\n".join([f"Date: {period(dates)}", next(iter(names), "9999"),
                      "ADV  LAT   LON       TIME     WIND  PR", *records])
