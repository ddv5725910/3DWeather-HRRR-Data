# 3DWeather HRRR Data

Public, automatically refreshed NOAA HRRR cloud tiles consumed by the private
3DWeather application.

The hourly workflow reads only `HGT`, `CLMR`, and `CIMIXR` for twelve pressure
levels from the public NOAA HRRR CONUS pressure product. It uses the adjacent
GRIB index and validated HTTP byte ranges, preserving the operational Lambert
`1799 × 1059` grid at 3 km. Five exact `2 × 2` area-mean levels provide
`6 / 12 / 24 / 48 / 96 km` LODs.

Generated data is published under the stable
[`hrrr-cloud-data`](../../releases/tag/hrrr-cloud-data) Release as one manifest
and 59 independently loadable tiles. The assets are replaced every hour rather
than committed to Git history.

Data source: [NOAA HRRR Open Data](https://registry.opendata.aws/noaa-hrrr-pds/).
This visualization feed is not intended for operational aviation use.
