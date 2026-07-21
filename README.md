# 3DWeather HRRR Data

Public, automatically refreshed NOAA HRRR cloud and wind tiles consumed by the
private 3DWeather application.

The hourly cloud workflow reads only `HGT`, `CLMR`, and `CIMIXR` for twelve
pressure levels from the public NOAA HRRR CONUS pressure product. It uses the
adjacent GRIB index and validated HTTP byte ranges, preserving the operational
Lambert `1799 × 1059` grid at 3 km. Five exact `2 × 2` area-mean levels provide
`6 / 12 / 24 / 48 / 96 km` LODs.

Generated data is published under the stable
[`hrrr-cloud-data`](../../releases/tag/hrrr-cloud-data) manifest. Its 31 hourly
valid times cover wall-clock **now −12 hours through now +18 hours**: past
hours use their own `f00` analyses, while now and the future use one complete
forecast cycle. Each time is a native 3 km, twelve-pressure-level density and
geopotential-height field.

Three adjacent times are packed into one time chunk, producing 649 independently
loadable spatial/LOD assets. Every build is first uploaded to an immutable
versioned Release; only after all assets exist is the stable manifest replaced.
This manifest-last publication prevents clients from seeing a half-uploaded
dataset. Four hourly Releases remain available for clients holding cached
manifests. Generated assets are never committed to Git history.

The wind workflow reads `UGRD` and `VGRD` at 10 m AGL plus the same twelve
pressure levels. It stores two hourly valid times as signed vector components
at 0.1 m/s, preserving the native 3 km grid. Coarser LODs average U/V
components, never direction angles. The manifest records HRRR's
`winds(grid)` convention so the browser can rotate grid-relative U/V into
geographic east/north with the Lambert convergence angle. One manifest and 59
tiles are replaced hourly under the stable
[`hrrr-wind-data`](../../releases/tag/hrrr-wind-data) Release.
Before building, the workflow verifies that both `f00` and `f01` inventories
contain the required wind fields and walks back to the newest complete cycle;
a partially published current cycle therefore cannot fail the hourly update.

Data source: [NOAA HRRR Open Data](https://registry.opendata.aws/noaa-hrrr-pds/).
This visualization feed is not intended for operational aviation use.
