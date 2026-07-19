# 3DWeather HRRR Data

Public, automatically refreshed NOAA HRRR cloud and wind tiles consumed by the
private 3DWeather application.

The hourly workflow reads only `HGT`, `CLMR`, and `CIMIXR` for twelve pressure
levels from the public NOAA HRRR CONUS pressure product. It uses the adjacent
GRIB index and validated HTTP byte ranges, preserving the operational Lambert
`1799 × 1059` grid at 3 km. Five exact `2 × 2` area-mean levels provide
`6 / 12 / 24 / 48 / 96 km` LODs.

Generated data is published under the stable
[`hrrr-cloud-data`](../../releases/tag/hrrr-cloud-data) Release as one manifest
and 59 independently loadable tiles. The assets are replaced every hour rather
than committed to Git history.

The wind workflow reads `UGRD` and `VGRD` at 10 m AGL plus the same twelve
pressure levels. It stores two hourly valid times as signed vector components
at 0.1 m/s, preserving the native 3 km grid. Coarser LODs average U/V
components, never direction angles. The manifest records HRRR's
`winds(grid)` convention so the browser can rotate grid-relative U/V into
geographic east/north with the Lambert convergence angle. One manifest and 59
tiles are replaced hourly under the stable
[`hrrr-wind-data`](../../releases/tag/hrrr-wind-data) Release.

Data source: [NOAA HRRR Open Data](https://registry.opendata.aws/noaa-hrrr-pds/).
This visualization feed is not intended for operational aviation use.
