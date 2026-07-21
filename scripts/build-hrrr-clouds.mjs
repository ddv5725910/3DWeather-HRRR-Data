#!/usr/bin/env node
// Build a native-grid browser tile pyramid from NOAA's HRRR pressure product.
//
// The builder deliberately does not download the ~400 MiB GRIB file. It reads
// the adjacent .idx inventory and uses byte ranges for only HGT, CLMR and
// CIMIXR at the pressure levels consumed by the voxel renderer. wgrib2 then
// preserves the operational Lambert grid, builds an exact 2× horizontal LOD
// pyramid, and publishes independently loadable tiles. Browsers therefore
// fetch native 3 km values only for the visible region instead of downloading
// or decoding the complete CONUS volume.

import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'dist/hrrr-clouds/hrrr-cloud-manifest.js');
const NOAA_S3 = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com';
const SOURCE_PAGE = 'https://registry.opendata.aws/noaa-hrrr-pds/';
const RELEASE_BASE_URL = 'https://github.com/ddv5725910/3DWeather-HRRR-Data/releases/download/hrrr-cloud-data/';
const USER_AGENT = '3DWeather HRRR cloud snapshot builder (https://github.com/ddv5725910/3DWeather-HRRR-Data)';
const FETCH_ATTEMPTS = 4;
const FETCH_TIMEOUT_MS = 30_000;
const RANGE_CONCURRENCY = 4;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export const LOD_COUNT = 6;
export const TILE_SIZE = 256;
export const HISTORY_HOURS = 12;
export const FORECAST_HOURS = 18;
export const TIME_CHUNK_SIZE = 3;

export const LEVELS = Object.freeze([1000, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150]);
export const STANDARD_HEIGHTS_M = Object.freeze([111, 988, 1457, 1949, 3012, 4206, 5574, 7185, 9164, 10363, 11784, 13608]);
export const VARIABLES = Object.freeze(['HGT', 'CLMR', 'CIMIXR']);
export const DEFAULT_GRID = Object.freeze({
  west:-132,
  south:21,
  east:-60,
  north:55,
  // Used only by the checked-in emergency preview/bootstrap generator. The
  // production path below preserves the 1799×1059 Lambert grid at 3 km.
  resolution:0.09375
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get?.('retry-after');
  const seconds = retryAfter && Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  return Math.min(12_000, 750 * 2 ** attempt + Math.round(Math.random() * 250));
}

async function fetchResponse(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || wait;
  const attempts = Math.max(1, options.attempts || FETCH_ATTEMPTS);
  const timeoutMs = Math.max(1, options.timeoutMs || FETCH_TIMEOUT_MS);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`request timeout ${timeoutMs}ms`)), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        ...options.request,
        headers:{ 'User-Agent':USER_AGENT, ...(options.request?.headers || {}) },
        signal:controller.signal
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${url}`);
        error.retryable = RETRYABLE_STATUS.has(response.status);
        throw error;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt + 1 >= attempts) break;
      await sleep(retryDelay(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`HRRR request failed after ${attempts} attempts: ${lastError?.message || url}`, { cause:lastError });
}

export function runParts(runMs) {
  const date = new Date(runMs);
  const day = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return { day, hour, iso:`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${hour}:00:00Z` };
}

export function timelineFrameSpecs(
  anchorMs,
  historyHours = HISTORY_HOURS,
  forecastHours = FORECAST_HOURS,
  chunkSize = TIME_CHUNK_SIZE,
  forecastRunMs = anchorMs
) {
  if (!Number.isFinite(+anchorMs)) throw new Error('Timeline anchor must be a UTC time');
  const anchor = Math.floor(+anchorMs / 3_600_000) * 3_600_000;
  const forecastRun = Math.floor(+forecastRunMs / 3_600_000) * 3_600_000;
  if (!Number.isFinite(forecastRun) || forecastRun > anchor) {
    throw new Error('Timeline forecast run must be at or before the UTC anchor');
  }
  const history = Math.max(0, Math.round(+historyHours || 0));
  const forecast = Math.max(0, Math.round(+forecastHours || 0));
  const groupSize = Math.max(1, Math.round(+chunkSize || 1));
  const frames = [];
  for (let offsetHour = -history; offsetHour <= forecast; offsetHour++) {
    const validMs = anchor + offsetHour * 3_600_000;
    // Past frames use their own f00 analysis. "Now" and future frames all use
    // one complete forecast run, which may be a few hours behind wall-clock
    // time while still targeting the exact real UTC hour on the timeline.
    const sourceRunMs = offsetHour < 0 ? validMs : forecastRun;
    const forecastHour = offsetHour < 0
      ? 0
      : Math.round((validMs - forecastRun) / 3_600_000);
    const valid = runParts(validMs);
    const index = frames.length;
    frames.push({
      id:`v${valid.day}${valid.hour}`,
      validTime:valid.iso,
      sourceRun:runParts(sourceRunMs).iso,
      sourceRunMs,
      forecastHour,
      kind:forecastHour === 0 ? 'analysis' : 'forecast',
      offsetHour,
      timeChunk:`t${String(Math.floor(index / groupSize)).padStart(2, '0')}`,
      timeIndex:index % groupSize
    });
  }
  return frames;
}

export function productUrl(runMs, forecastHour, suffix = '') {
  const { day, hour } = runParts(runMs);
  const fhr = String(forecastHour).padStart(2, '0');
  return `${NOAA_S3}/hrrr.${day}/conus/hrrr.t${hour}z.wrfprsf${fhr}.grib2${suffix}`;
}

export function parseIndex(text, contentLength = NaN) {
  const knownLength = Number.isFinite(+contentLength) && +contentLength > 0 ? +contentLength : NaN;
  const records = String(text || '').trim().split(/\r?\n/).filter(Boolean).map((line, lineIndex) => {
    const match = line.match(/^(\d+):(\d+):(.*)$/);
    if (!match) throw new Error(`Invalid HRRR index line ${lineIndex + 1}: ${line}`);
    return {
      record:+match[1],
      offset:+match[2],
      inventory:match[3],
      line
    };
  });
  for (let index = 0; index < records.length; index++) {
    const endExclusive = records[index + 1]?.offset ?? knownLength;
    if (!Number.isFinite(endExclusive)) {
      records[index].end = NaN;
      records[index].bytes = NaN;
      continue;
    }
    if (endExclusive <= records[index].offset) {
      throw new Error(`HRRR index has no valid end offset for record ${records[index].record}`);
    }
    records[index].end = endExclusive - 1;
    records[index].bytes = endExclusive - records[index].offset;
  }
  return records;
}

export function selectCloudRecords(records) {
  const selected = [];
  for (const level of LEVELS) {
    for (const variable of VARIABLES) {
      const token = `:${variable}:${level} mb:`;
      const record = records.find(item => item.line.includes(token));
      if (!record) throw new Error(`HRRR index is missing ${variable} at ${level} mb`);
      if (!Number.isFinite(record.end) || !Number.isFinite(record.bytes)) {
        throw new Error(`HRRR index has no byte boundary after ${variable} at ${level} mb`);
      }
      selected.push({ ...record, level, variable });
    }
  }
  return selected;
}

export function coalesceCloudRanges(selected) {
  const ranges = [];
  for (let index = 0; index < selected.length; index++) {
    const first = selected[index];
    const next = selected[index + 1];
    // CLMR and CIMIXR are adjacent in the operational pressure inventory.
    // Fetching the pair in one request halves the small-message request count.
    if (first.variable === 'CLMR' && next?.variable === 'CIMIXR' &&
        first.level === next.level && first.end + 1 === next.offset) {
      ranges.push({
        start:first.offset,
        end:next.end,
        bytes:next.end - first.offset + 1,
        records:[first, next]
      });
      index++;
    } else {
      ranges.push({
        start:first.offset,
        end:first.end,
        bytes:first.bytes,
        records:[first]
      });
    }
  }
  return ranges;
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length:Math.min(limit, items.length) }, consume));
  return output;
}

export async function fetchByteRanges(url, ranges, options = {}) {
  return mapLimit(ranges, options.concurrency || RANGE_CONCURRENCY, async range => {
    const response = await fetchResponse(url, {
      ...options,
      request:{ headers:{ Range:`bytes=${range.start}-${range.end}` } }
    });
    if (response.status !== 206) {
      throw new Error(`HRRR range request returned HTTP ${response.status}; refusing an accidental full-file download`);
    }
    const contentRange = response.headers.get('content-range') || '';
    const expectedPrefix = `bytes ${range.start}-${range.end}/`;
    if (!contentRange.startsWith(expectedPrefix)) {
      throw new Error(`Unexpected HRRR Content-Range: ${contentRange || '(missing)'}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== range.bytes) {
      throw new Error(`Truncated HRRR range ${range.start}-${range.end}: ${buffer.length}/${range.bytes}`);
    }
    return buffer;
  });
}

export async function resolveLatestRun(options = {}) {
  const now = Number.isFinite(+options.now) ? +options.now : Date.now();
  const requiredValidTime = Number.isFinite(+options.requiredValidTime)
    ? Math.floor(+options.requiredValidTime / 3_600_000) * 3_600_000
    : NaN;
  const requestedForecastHours = Array.isArray(options.forecastHours)
    ? [...new Set(options.forecastHours.map(Number))]
    : null;
  const requiredIndexTokens = Array.isArray(options.requiredIndexTokens) && options.requiredIndexTokens.length
    ? options.requiredIndexTokens.map(String)
    : [':HGT:1000 mb:', ':CIMIXR:850 mb:'];
  // Operational files are not instantaneous at the top of the hour. Start
  // from the prior UTC hour, then walk backwards without retrying nonexistent
  // cycles as if they were transient server failures.
  const first = Math.floor((now - 45 * 60_000) / 3_600_000) * 3_600_000;
  const fetchImpl = options.fetchImpl || fetch;
  for (let offset = 0; offset < 8; offset++) {
    const runMs = first - offset * 3_600_000;
    const forecastHours = requestedForecastHours || [Number.isFinite(requiredValidTime)
      ? Math.round((requiredValidTime - runMs) / 3_600_000)
      : 1];
    if (!forecastHours.length || forecastHours.some(hour =>
      !Number.isInteger(hour) || hour < 0 || hour > 48
    )) continue;
    try {
      let complete = true;
      for (const forecastHour of forecastHours) {
        const response = await fetchResponse(productUrl(runMs, forecastHour, '.idx'), {
          fetchImpl,
          attempts:1,
          timeoutMs:options.timeoutMs || 12_000
        });
        const text = await response.text();
        if (!requiredIndexTokens.every(token => text.includes(token))) {
          complete = false;
          break;
        }
      }
      if (complete) return runMs;
    } catch (error) {
      if (options.onProbeError) options.onProbeError(runMs, error);
    }
  }
  throw new Error('No complete HRRR pressure cycle was found in the last 8 hours');
}

function gridDefinition(options = {}) {
  const west = Number.isFinite(+options.west) ? +options.west : DEFAULT_GRID.west;
  const south = Number.isFinite(+options.south) ? +options.south : DEFAULT_GRID.south;
  const east = Number.isFinite(+options.east) ? +options.east : DEFAULT_GRID.east;
  const north = Number.isFinite(+options.north) ? +options.north : DEFAULT_GRID.north;
  const resolution = Number.isFinite(+options.resolution) ? +options.resolution : DEFAULT_GRID.resolution;
  if (!(resolution > 0) || !(east > west) || !(north > south)) throw new Error('Invalid HRRR output grid');
  const nx = Math.ceil((east - west) / resolution) + 1;
  const ny = Math.ceil((north - south) / resolution) + 1;
  return {
    west, south, resolution, nx, ny,
    east:west + (nx - 1) * resolution,
    north:south + (ny - 1) * resolution
  };
}

function runWgrib2(executable, args, label) {
  const result = spawnSync(executable, args, { encoding:'utf8', maxBuffer:8 * 1024 * 1024 });
  if (result.error) throw new Error(`${label}: ${result.error.message}`, { cause:result.error });
  if (result.status !== 0) {
    throw new Error(`${label} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout || '';
}

export function parseNativeGrid(text) {
  const value = String(text || '');
  const dimensions = value.match(/Lambert Conformal:\s*\((\d+)\s*x\s*(\d+)\)/i);
  const firstPoint = value.match(
    /Lat1\s+(-?\d+(?:\.\d+)?)\s+Lon1\s+(-?\d+(?:\.\d+)?)\s+LoV\s+(-?\d+(?:\.\d+)?)/i
  );
  const parallels = value.match(
    /LatD\s+(-?\d+(?:\.\d+)?)\s+Latin1\s+(-?\d+(?:\.\d+)?)\s+Latin2\s+(-?\d+(?:\.\d+)?)/i
  );
  const spacing = value.match(/Dx\s+(\d+(?:\.\d+)?)\s*m\s+Dy\s+(\d+(?:\.\d+)?)\s*m/i);
  if (!dimensions || !firstPoint || !parallels || !spacing) {
    throw new Error(`Unable to parse native HRRR Lambert grid: ${value.slice(0, 500)}`);
  }
  const wrapLongitude = longitude => {
    const wrapped = ((+longitude + 180) % 360 + 360) % 360 - 180;
    return Object.is(wrapped, -0) ? 0 : wrapped;
  };
  const grid = {
    projection:'lambert-conformal',
    scanningMode:'WE:SN',
    nx:+dimensions[1],
    ny:+dimensions[2],
    firstLat:+firstPoint[1],
    firstLon:wrapLongitude(firstPoint[2]),
    orientationLon:wrapLongitude(firstPoint[3]),
    latitudeOfOrigin:+parallels[1],
    standardParallel1:+parallels[2],
    standardParallel2:+parallels[3],
    dxM:+spacing[1],
    dyM:+spacing[2],
    // GRIB2 template 3.30 uses the spherical Earth definition carried by the
    // operational HRRR product. wgrib2 reports the grid on this NCEP sphere.
    earthRadiusM:6371229
  };
  if (grid.nx !== 1799 || grid.ny !== 1059 ||
      Math.abs(grid.dxM - 3000) > 0.01 || Math.abs(grid.dyM - 3000) > 0.01) {
    throw new Error(
      `Unexpected HRRR native grid ${grid.nx}×${grid.ny} at ${grid.dxM}×${grid.dyM} m`
    );
  }
  return grid;
}

function validFloat(value) {
  return Number.isFinite(value) && Math.abs(value) < 1e10;
}

export function validateRegriddedInventory(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  const expected = [];
  for (let time = 0; time < 2; time++) for (const level of LEVELS) for (const variable of VARIABLES) {
    expected.push({ time, level, variable });
  }
  if (lines.length !== expected.length) {
    throw new Error(`Unexpected regridded HRRR field count: ${lines.length}/${expected.length}`);
  }
  for (let index = 0; index < expected.length; index++) {
    const item = expected[index];
    if (!lines[index].includes(`:${item.variable}:${item.level} mb:`)) {
      throw new Error(`Unexpected regridded field ${index + 1}: ${lines[index]}`);
    }
    const forecastMatches = item.time === 0
      ? /:(?:anl|0 hour fcst):/.test(lines[index])
      : /:1 hour fcst:/.test(lines[index]);
    if (!forecastMatches) throw new Error(`Unexpected HRRR valid time at field ${index + 1}: ${lines[index]}`);
  }
  return true;
}

export function validateTimelineFrameInventory(text, forecastHour = 0) {
  const hour = Math.max(0, Math.round(+forecastHour || 0));
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  const expected = [];
  for (const level of LEVELS) for (const variable of VARIABLES) {
    expected.push({ level, variable });
  }
  if (lines.length !== expected.length) {
    throw new Error(`Unexpected HRRR timeline field count: ${lines.length}/${expected.length}`);
  }
  for (let index = 0; index < expected.length; index++) {
    const item = expected[index];
    const line = lines[index];
    if (!line.includes(`:${item.variable}:${item.level} mb:`)) {
      throw new Error(`Unexpected HRRR timeline field ${index + 1}: ${line}`);
    }
    const validForecast = hour === 0
      ? /:(?:anl|0 hour fcst):/.test(line)
      : new RegExp(`:${hour} hour fcst:`).test(line);
    if (!validForecast) {
      throw new Error(`Unexpected HRRR timeline valid time at field ${index + 1}: ${line}`);
    }
  }
  return true;
}

export function condensateDensity(cloudLiquid, cloudIce) {
  const liquid = validFloat(cloudLiquid) && cloudLiquid > 0 ? cloudLiquid : 0;
  const ice = validFloat(cloudIce) && cloudIce > 0 ? cloudIce : 0;
  // Cloud condensate is a mixing ratio, not a percentage. This monotonic,
  // saturating transfer preserves HRRR's zero/nonzero structure and relative
  // mass while producing the renderer's 0–100 density domain. q=7.5e-5 kg/kg
  // maps to 63%; the developer density/threshold controls remain visual only.
  return Math.max(0, Math.min(100, Math.round(100 * (1 - Math.exp(-(liquid + ice) / 7.5e-5)))));
}

export function packRegriddedBinary(raw, grid) {
  const points = grid.nx * grid.ny;
  const fieldsPerTime = LEVELS.length * VARIABLES.length;
  const expectedBytes = 2 * fieldsPerTime * points * 4;
  if (raw.length !== expectedBytes) {
    throw new Error(`Unexpected wgrib2 binary size: ${raw.length}/${expectedBytes}`);
  }
  const values = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const samples = points * LEVELS.length;
  const packed = Buffer.allocUnsafe(samples * 6);
  const cover0 = 0;
  const cover1 = samples;
  const height0 = samples * 2;
  const height1 = samples * 4;

  for (let time = 0; time < 2; time++) {
    const coverBase = time ? cover1 : cover0;
    const heightBase = time ? height1 : height0;
    for (let level = 0; level < LEVELS.length; level++) {
      const field = time * fieldsPerTime + level * VARIABLES.length;
      const hOffset = field * points;
      const liquidOffset = (field + 1) * points;
      const iceOffset = (field + 2) * points;
      for (let point = 0; point < points; point++) {
        const sample = point * LEVELS.length + level;
        packed[coverBase + sample] = condensateDensity(values[liquidOffset + point], values[iceOffset + point]);
        const height = values[hOffset + point];
        const safeHeight = validFloat(height) && height >= -1000 && height <= 30_000
          ? height
          : STANDARD_HEIGHTS_M[level];
        packed.writeUInt16LE(Math.round(Math.max(0, Math.min(30_000, safeHeight))), heightBase + sample * 2);
      }
    }
  }

  // Guard the vertical interpolation against below-ground/missing pressure
  // surfaces. Actual HRRR heights are retained; only inversions are lifted by
  // the minimum 50 m separation already required by the renderer.
  for (let time = 0; time < 2; time++) {
    const heightBase = time ? height1 : height0;
    for (let point = 0; point < points; point++) {
      let previous = 0;
      for (let level = 0; level < LEVELS.length; level++) {
        const offset = heightBase + (point * LEVELS.length + level) * 2;
        const height = Math.max(packed.readUInt16LE(offset), previous + (level ? 50 : 0));
        packed.writeUInt16LE(Math.min(30_000, height), offset);
        previous = height;
      }
    }
  }
  return packed;
}

export function packTimelineFrameBinary(raw, grid) {
  const points = grid.nx * grid.ny;
  const fields = LEVELS.length * VARIABLES.length;
  const expectedBytes = fields * points * 4;
  if (raw.length !== expectedBytes) {
    throw new Error(`Unexpected timeline wgrib2 binary size: ${raw.length}/${expectedBytes}`);
  }
  const values = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const samples = points * LEVELS.length;
  const packed = Buffer.allocUnsafe(samples * 3);
  const heightBase = samples;
  for (let level = 0; level < LEVELS.length; level++) {
    const field = level * VARIABLES.length;
    const hOffset = field * points;
    const liquidOffset = (field + 1) * points;
    const iceOffset = (field + 2) * points;
    for (let point = 0; point < points; point++) {
      const sample = point * LEVELS.length + level;
      packed[sample] = condensateDensity(
        values[liquidOffset + point],
        values[iceOffset + point]
      );
      const height = values[hOffset + point];
      const safeHeight = validFloat(height) && height >= -1000 && height <= 30_000
        ? height
        : STANDARD_HEIGHTS_M[level];
      packed.writeUInt16LE(
        Math.round(Math.max(0, Math.min(30_000, safeHeight))),
        heightBase + sample * 2
      );
    }
  }
  for (let point = 0; point < points; point++) {
    let previous = 0;
    for (let level = 0; level < LEVELS.length; level++) {
      const offset = heightBase + (point * LEVELS.length + level) * 2;
      const height = Math.max(
        packed.readUInt16LE(offset),
        previous + (level ? 50 : 0)
      );
      packed.writeUInt16LE(Math.min(30_000, height), offset);
      previous = height;
    }
  }
  return packed;
}

export function downsamplePackedGrid(packed, grid, factor = 3) {
  const step = Math.max(2, Math.round(+factor || 3));
  const sourceSamples = grid.nx * grid.ny * LEVELS.length;
  if (packed.length !== sourceSamples * 6) {
    throw new Error(`Packed HRRR length does not match grid: ${packed.length}/${sourceSamples * 6}`);
  }
  const nx = Math.floor((grid.nx - 1) / step) + 1;
  const ny = Math.floor((grid.ny - 1) / step) + 1;
  const targetSamples = nx * ny * LEVELS.length;
  const result = Buffer.alloc(targetSamples * 6);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const sourcePoint = (y * step * grid.nx + x * step) * LEVELS.length;
    const targetPoint = (y * nx + x) * LEVELS.length;
    for (let level = 0; level < LEVELS.length; level++) {
      const sourceIndex = sourcePoint + level;
      const targetIndex = targetPoint + level;
      result[targetIndex] = packed[sourceIndex];
      result[targetSamples + targetIndex] = packed[sourceSamples + sourceIndex];
      result.writeUInt16LE(
        packed.readUInt16LE(sourceSamples * 2 + sourceIndex * 2),
        targetSamples * 2 + targetIndex * 2
      );
      result.writeUInt16LE(
        packed.readUInt16LE(sourceSamples * 4 + sourceIndex * 2),
        targetSamples * 4 + targetIndex * 2
      );
    }
  }
  const resolution = grid.resolution * step;
  return {
    packed:result,
    grid:{
      west:grid.west,
      south:grid.south,
      east:grid.west + (nx - 1) * resolution,
      north:grid.south + (ny - 1) * resolution,
      resolution,
      nx,
      ny
    }
  };
}

function packedLayout(packed, grid) {
  const points = grid.nx * grid.ny;
  const samples = points * LEVELS.length;
  if (packed.length !== samples * 6) {
    throw new Error(`Packed HRRR length does not match grid: ${packed.length}/${samples * 6}`);
  }
  return {
    points,
    samples,
    cover0:0,
    cover1:samples,
    height0:samples * 2,
    height1:samples * 4
  };
}

export function downsamplePackedGrid2x(packed, grid) {
  const source = packedLayout(packed, grid);
  const nx = Math.ceil(grid.nx / 2);
  const ny = Math.ceil(grid.ny / 2);
  const targetGrid = {
    ...grid,
    nx,
    ny,
    dxM:grid.dxM * 2,
    dyM:grid.dyM * 2
  };
  const targetSamples = nx * ny * LEVELS.length;
  const result = Buffer.alloc(targetSamples * 6);
  const blocks = [
    { source:source.cover0, target:0, bytes:1 },
    { source:source.cover1, target:targetSamples, bytes:1 },
    { source:source.height0, target:targetSamples * 2, bytes:2 },
    { source:source.height1, target:targetSamples * 4, bytes:2 }
  ];
  const readValue = (block, sample) => block.bytes === 1
    ? packed[block.source + sample]
    : packed.readUInt16LE(block.source + sample * 2);
  const writeValue = (block, sample, value) => {
    if (block.bytes === 1) result[block.target + sample] = value;
    else result.writeUInt16LE(value, block.target + sample * 2);
  };
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    for (let level = 0; level < LEVELS.length; level++) {
      const targetSample = (y * nx + x) * LEVELS.length + level;
      for (const block of blocks) {
        let sum = 0, count = 0;
        for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
          const sx = x * 2 + ox, sy = y * 2 + oy;
          if (sx >= grid.nx || sy >= grid.ny) continue;
          const sourceSample = (sy * grid.nx + sx) * LEVELS.length + level;
          sum += readValue(block, sourceSample);
          count++;
        }
        // A coarse voxel represents the physical area of its 2×2 children.
        // Area means avoid inventing cloud mass; HGT uses the same unbiased
        // aggregation so pressure-surface geometry remains spatially aligned.
        writeValue(block, targetSample, Math.round(sum / Math.max(1, count)));
      }
    }
  }
  return { packed:result, grid:targetGrid };
}

export function extractPackedTile(packed, grid, tileX, tileY, tileSize = TILE_SIZE) {
  const source = packedLayout(packed, grid);
  const x0 = tileX * tileSize, y0 = tileY * tileSize;
  const nx = Math.max(0, Math.min(tileSize, grid.nx - x0));
  const ny = Math.max(0, Math.min(tileSize, grid.ny - y0));
  if (!nx || !ny) throw new Error(`Tile ${tileX},${tileY} is outside ${grid.nx}×${grid.ny}`);
  const samples = nx * ny * LEVELS.length;
  const result = Buffer.alloc(samples * 6);
  const copyBlock = (sourceOffset, targetOffset, bytes) => {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const sourceSample = ((y0 + y) * grid.nx + x0 + x) * LEVELS.length;
      const targetSample = (y * nx + x) * LEVELS.length;
      packed.copy(
        result,
        targetOffset + targetSample * bytes,
        sourceOffset + sourceSample * bytes,
        sourceOffset + (sourceSample + LEVELS.length) * bytes
      );
    }
  };
  copyBlock(source.cover0, 0, 1);
  copyBlock(source.cover1, samples, 1);
  copyBlock(source.height0, samples * 2, 2);
  copyBlock(source.height1, samples * 4, 2);
  return { packed:result, x0, y0, nx, ny };
}

function timelinePackedLayout(packed, grid) {
  const samples = grid.nx * grid.ny * LEVELS.length;
  if (packed.length !== samples * 3) {
    throw new Error(`Packed timeline frame does not match grid: ${packed.length}/${samples * 3}`);
  }
  return { samples, cover:0, height:samples };
}

export function downsampleTimelineFrame2x(packed, grid) {
  const source = timelinePackedLayout(packed, grid);
  const nx = Math.ceil(grid.nx / 2);
  const ny = Math.ceil(grid.ny / 2);
  const targetGrid = {
    ...grid,
    nx,
    ny,
    dxM:grid.dxM * 2,
    dyM:grid.dyM * 2
  };
  const targetSamples = nx * ny * LEVELS.length;
  const result = Buffer.alloc(targetSamples * 3);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    for (let level = 0; level < LEVELS.length; level++) {
      const targetSample = (y * nx + x) * LEVELS.length + level;
      let coverSum = 0, heightSum = 0, count = 0;
      for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
        const sx = x * 2 + ox, sy = y * 2 + oy;
        if (sx >= grid.nx || sy >= grid.ny) continue;
        const sourceSample = (sy * grid.nx + sx) * LEVELS.length + level;
        coverSum += packed[source.cover + sourceSample];
        heightSum += packed.readUInt16LE(source.height + sourceSample * 2);
        count++;
      }
      result[targetSample] = Math.round(coverSum / Math.max(1, count));
      result.writeUInt16LE(
        Math.round(heightSum / Math.max(1, count)),
        targetSamples + targetSample * 2
      );
    }
  }
  return { packed:result, grid:targetGrid };
}

export function extractTimelineFrameTile(
  packed,
  grid,
  tileX,
  tileY,
  tileSize = TILE_SIZE
) {
  const source = timelinePackedLayout(packed, grid);
  const x0 = tileX * tileSize, y0 = tileY * tileSize;
  const nx = Math.max(0, Math.min(tileSize, grid.nx - x0));
  const ny = Math.max(0, Math.min(tileSize, grid.ny - y0));
  if (!nx || !ny) throw new Error(`Timeline tile ${tileX},${tileY} is outside ${grid.nx}×${grid.ny}`);
  const samples = nx * ny * LEVELS.length;
  const result = Buffer.alloc(samples * 3);
  const copyBlock = (sourceOffset, targetOffset, bytes) => {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const sourceSample = ((y0 + y) * grid.nx + x0 + x) * LEVELS.length;
      const targetSample = (y * nx + x) * LEVELS.length;
      packed.copy(
        result,
        targetOffset + targetSample * bytes,
        sourceOffset + sourceSample * bytes,
        sourceOffset + (sourceSample + LEVELS.length) * bytes
      );
    }
  };
  copyBlock(source.cover, 0, 1);
  copyBlock(source.height, samples, 2);
  return { packed:result, x0, y0, nx, ny };
}

export function cloudTimelineTileSource(meta, frameTiles) {
  if (!Array.isArray(frameTiles) || !frameTiles.length) {
    throw new Error('Timeline tile requires at least one frame');
  }
  const packed = Buffer.concat(frameTiles);
  const payload = gzipSync(packed, { level:9, mtime:0 }).toString('base64');
  const tile = {
    schemaVersion:3,
    datasetId:meta.datasetId,
    timeChunk:meta.timeChunk,
    frameIds:meta.frameIds,
    validTimes:meta.validTimes,
    lod:meta.lod,
    tileX:meta.tileX,
    tileY:meta.tileY,
    x0:meta.x0,
    y0:meta.y0,
    nx:meta.nx,
    ny:meta.ny,
    encoding:'gzip+base64; frame-major[cover:u8,height:u16le]; point-major-level-minor',
    uncompressedBytes:packed.length,
    payload
  };
  return `// Generated native HRRR cloud timeline tile; do not edit.\n` +
    `(function(g){var t=Object.freeze(${JSON.stringify(tile)});` +
    `if(typeof g.__acceptHrrrCloudTile==="function")g.__acceptHrrrCloudTile(t);` +
    `else(g.HRRR_CLOUD_TILE_QUEUE||(g.HRRR_CLOUD_TILE_QUEUE=[])).push(t);` +
    `})(typeof window!=="undefined"?window:globalThis);\n`;
}

export function cloudTileSource(meta, packed) {
  const payload = gzipSync(packed, { level:9, mtime:0 }).toString('base64');
  const tile = {
    schemaVersion:2,
    datasetId:meta.datasetId,
    lod:meta.lod,
    tileX:meta.tileX,
    tileY:meta.tileY,
    x0:meta.x0,
    y0:meta.y0,
    nx:meta.nx,
    ny:meta.ny,
    encoding:'gzip+base64; cover0:u8,cover1:u8,height0:u16le,height1:u16le; point-major-level-minor',
    uncompressedBytes:packed.length,
    payload
  };
  return `// Generated native HRRR cloud tile; do not edit.\n` +
    `(function(g){var t=Object.freeze(${JSON.stringify(tile)});` +
    `if(typeof g.__acceptHrrrCloudTile==="function")g.__acceptHrrrCloudTile(t);` +
    `else(g.HRRR_CLOUD_TILE_QUEUE||(g.HRRR_CLOUD_TILE_QUEUE=[])).push(t);` +
    `})(typeof window!=="undefined"?window:globalThis);\n`;
}

export function cloudManifestSource(meta) {
  const manifest = {
    schemaVersion:2,
    source:'NOAA HRRR CONUS pressure product',
    sourceUrl:SOURCE_PAGE,
    product:'wrfprsf',
    generatedAt:meta.generatedAt,
    run:meta.run,
    validTimes:meta.validTimes,
    levels:LEVELS,
    variables:{
      height:'HGT',
      density:['CLMR', 'CIMIXR'],
      densityTransfer:'100*(1-exp(-(CLMR+CIMIXR)/7.5e-5))'
    },
    datasetId:meta.datasetId,
    projection:meta.projection,
    tileSize:meta.tileSize,
    lods:meta.lods,
    tileUrlTemplate:'hrrr-cloud-l{lod}-x{x}-y{y}.js',
    releaseBaseUrl:meta.releaseBaseUrl || RELEASE_BASE_URL,
    nativeResolutionM:meta.projection.dxM,
    aggregation:'2x2-area-mean'
  };
  return `// Generated native HRRR cloud manifest; do not edit.\n` +
    `(function(g){g.HRRR_CLOUD_MANIFEST=Object.freeze(${JSON.stringify(manifest)});` +
    `})(typeof window!=="undefined"?window:globalThis);\n`;
}

export function cloudTimelineManifestSource(meta) {
  const manifest = {
    schemaVersion:3,
    source:'NOAA HRRR CONUS pressure product',
    sourceUrl:SOURCE_PAGE,
    product:'wrfprsf',
    generatedAt:meta.generatedAt,
    run:meta.run,
    anchorTime:meta.anchorTime,
    historyHours:meta.historyHours,
    forecastHours:meta.forecastHours,
    timeStepMinutes:60,
    timeChunkSize:meta.timeChunkSize,
    validTimes:meta.frames.map(frame => frame.validTime),
    frames:meta.frames.map(frame => ({
      id:frame.id,
      validTime:frame.validTime,
      sourceRun:frame.sourceRun,
      forecastHour:frame.forecastHour,
      kind:frame.kind,
      timeChunk:frame.timeChunk,
      timeIndex:frame.timeIndex
    })),
    levels:LEVELS,
    variables:{
      height:'HGT',
      density:['CLMR', 'CIMIXR'],
      densityTransfer:'100*(1-exp(-(CLMR+CIMIXR)/7.5e-5))'
    },
    datasetId:meta.datasetId,
    projection:meta.projection,
    tileSize:meta.tileSize,
    lods:meta.lods,
    tileUrlTemplate:'hrrr-cloud-{timeChunk}-l{lod}-x{x}-y{y}.js',
    releaseBaseUrl:meta.releaseBaseUrl || RELEASE_BASE_URL,
    nativeResolutionM:meta.projection.dxM,
    aggregation:'2x2-area-mean'
  };
  return `// Generated native HRRR cloud timeline manifest; do not edit.\n` +
    `(function(g){g.HRRR_CLOUD_MANIFEST=Object.freeze(${JSON.stringify(manifest)});` +
    `})(typeof window!=="undefined"?window:globalThis);\n`;
}

export function snapshotSource(meta, packed) {
  const payload = gzipSync(packed, { level:9, mtime:0 }).toString('base64');
  const snapshot = {
    schemaVersion:1,
    source:'NOAA HRRR CONUS pressure product',
    sourceUrl:SOURCE_PAGE,
    product:'wrfprsf',
    preview:!!meta.preview,
    generatedAt:meta.generatedAt,
    run:meta.run,
    validTimes:meta.validTimes,
    levels:LEVELS,
    variables:{
      height:'HGT',
      density:['CLMR', 'CIMIXR'],
      densityTransfer:'100*(1-exp(-(CLMR+CIMIXR)/7.5e-5))'
    },
    grid:meta.grid,
    encoding:'gzip+base64; cover0:u8,cover1:u8,height0:u16le,height1:u16le; point-major-level-minor',
    uncompressedBytes:packed.length,
    payload
  };
  return `// Generated by scripts/build-hrrr-clouds.mjs; do not edit.\n` +
    `(function(g){g.HRRR_CLOUD_DATA=Object.freeze(${JSON.stringify(snapshot)});})(typeof window!=="undefined"?window:globalThis);\n`;
}

async function build(options = {}) {
  const historyHours = Number.isFinite(+options.historyHours)
    ? Math.max(0, Math.round(+options.historyHours))
    : HISTORY_HOURS;
  const forecastHours = Number.isFinite(+options.forecastHours)
    ? Math.max(0, Math.round(+options.forecastHours))
    : FORECAST_HOURS;
  const timeChunkSize = Number.isFinite(+options.timeChunkSize)
    ? Math.max(1, Math.round(+options.timeChunkSize))
    : TIME_CHUNK_SIZE;
  const explicitRun = Number.isFinite(+options.runMs);
  const anchorMs = Number.isFinite(+options.anchorMs)
    ? Math.floor(+options.anchorMs / 3_600_000) * 3_600_000
    : explicitRun
    ? Math.floor(+options.runMs / 3_600_000) * 3_600_000
    : Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const runMs = explicitRun
    ? Math.floor(+options.runMs / 3_600_000) * 3_600_000
    : await resolveLatestRun({
      requiredValidTime:anchorMs + forecastHours * 3_600_000,
      onProbeError:(time, error) => {
        console.warn(`HRRR ${runParts(time).iso} unavailable: ${error.message}`);
      }
    });
  const frames = timelineFrameSpecs(
    anchorMs,
    historyHours,
    forecastHours,
    timeChunkSize,
    runMs
  );
  const work = mkdtempSync(resolve(tmpdir(), '3dweather-hrrr-'));
  const miniGrib = resolve(work, 'selected.grib2');
  const rawBin = resolve(work, 'fields.bin');
  const out = resolve(options.out || DEFAULT_OUT);
  const outDir = dirname(out);
  const executable = options.wgrib2 || process.env.WGRIB2 || 'wgrib2';
  const generatedAt = new Date().toISOString();
  const datasetId = `${runParts(anchorMs).day}${runParts(anchorMs).hour}-timeline-${Date.parse(generatedAt)}`;
  try {
    rmSync(outDir, { recursive:true, force:true });
    mkdirSync(outDir, { recursive:true });

    let projection = null;
    let nativeGrid = null;
    let lods = null;
    let sourceBytes = 0;
    let publishedBytes = 0;
    let nativeDecodedBytes = 0;

    const chunks = [];
    for (const frame of frames) {
      let chunk = chunks[chunks.length - 1];
      if (!chunk || chunk.id !== frame.timeChunk) {
        chunk = { id:frame.timeChunk, frames:[] };
        chunks.push(chunk);
      }
      chunk.frames.push(frame);
    }

    for (const chunk of chunks) {
      const framePyramids = [];
      for (const frame of chunk.frames) {
        const indexUrl = productUrl(frame.sourceRunMs, frame.forecastHour, '.idx');
        const indexResponse = await fetchResponse(indexUrl);
        const records = parseIndex(await indexResponse.text());
        const selected = selectCloudRecords(records);
        const ranges = coalesceCloudRanges(selected);
        const gribUrl = productUrl(frame.sourceRunMs, frame.forecastHour);
        const expectedMiB = ranges.reduce((sum, range) => sum + range.bytes, 0) / 1024 / 1024;
        console.log(
          `${frame.id} ${frame.kind} f${String(frame.forecastHour).padStart(2, '0')}: ` +
          `${ranges.length} ranges, ${expectedMiB.toFixed(2)} MiB`
        );
        const buffers = await fetchByteRanges(gribUrl, ranges);
        const frameBytes = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
        sourceBytes += frameBytes;
        writeFileSync(miniGrib, Buffer.concat(buffers));

        const frameProjection = parseNativeGrid(runWgrib2(
          executable,
          [miniGrib, '-d', '1', '-grid'],
          `wgrib2 ${frame.id} native grid inspection`
        ));
        validateTimelineFrameInventory(
          runWgrib2(executable, [miniGrib, '-s'], `wgrib2 ${frame.id} inventory validation`),
          frame.forecastHour
        );
        if (!projection) {
          projection = frameProjection;
          nativeGrid = {
            nx:projection.nx,
            ny:projection.ny,
            dxM:projection.dxM,
            dyM:projection.dyM
          };
          lods = Array.from({ length:LOD_COUNT }, (_, lod) => {
            const nx = Math.ceil(nativeGrid.nx / 2 ** lod);
            const ny = Math.ceil(nativeGrid.ny / 2 ** lod);
            return {
              lod,
              horizontalSizeM:projection.dxM * 2 ** lod,
              nx,
              ny,
              tilesX:Math.ceil(nx / TILE_SIZE),
              tilesY:Math.ceil(ny / TILE_SIZE)
            };
          });
        } else {
          for (const key of [
            'nx', 'ny', 'dxM', 'dyM', 'firstLat', 'firstLon',
            'orientationLon', 'standardParallel1', 'standardParallel2'
          ]) {
            if (Math.abs(+frameProjection[key] - +projection[key]) > 1e-6) {
              throw new Error(`HRRR projection changed at ${frame.id}: ${key}`);
            }
          }
        }
        runWgrib2(executable, [
          miniGrib,
          '-order', 'we:sn',
          '-no_header',
          '-bin', rawBin
        ], `wgrib2 ${frame.id} binary export`);

        let level = {
          packed:packTimelineFrameBinary(readFileSync(rawBin), nativeGrid),
          grid:nativeGrid
        };
        nativeDecodedBytes += level.packed.length;
        const pyramid = [level];
        for (let lod = 1; lod < LOD_COUNT; lod++) {
          level = downsampleTimelineFrame2x(level.packed, level.grid);
          pyramid.push(level);
        }
        framePyramids.push(pyramid);
      }

      for (let lod = 0; lod < LOD_COUNT; lod++) {
        const lodMeta = lods[lod];
        for (let tileY = 0; tileY < lodMeta.tilesY; tileY++) {
          for (let tileX = 0; tileX < lodMeta.tilesX; tileX++) {
            const extracted = framePyramids.map(pyramid =>
              extractTimelineFrameTile(
                pyramid[lod].packed,
                pyramid[lod].grid,
                tileX,
                tileY,
                TILE_SIZE
              )
            );
            const first = extracted[0];
            const name = `hrrr-cloud-${chunk.id}-l${lod}-x${tileX}-y${tileY}.js`;
            const source = cloudTimelineTileSource({
              datasetId,
              timeChunk:chunk.id,
              frameIds:chunk.frames.map(frame => frame.id),
              validTimes:chunk.frames.map(frame => frame.validTime),
              lod,
              tileX,
              tileY,
              x0:first.x0,
              y0:first.y0,
              nx:first.nx,
              ny:first.ny
            }, extracted.map(tile => tile.packed));
            writeFileSync(resolve(outDir, name), source);
            publishedBytes += Buffer.byteLength(source);
          }
        }
      }
    }

    const manifest = cloudTimelineManifestSource({
      generatedAt,
      run:runParts(runMs).iso,
      anchorTime:runParts(anchorMs).iso,
      historyHours,
      forecastHours,
      timeChunkSize,
      frames,
      datasetId,
      projection,
      tileSize:TILE_SIZE,
      lods,
      releaseBaseUrl:options.releaseBaseUrl
    });
    const temporary = `${out}.tmp`;
    writeFileSync(temporary, manifest);
    renameSync(temporary, out);
    publishedBytes += Buffer.byteLength(manifest);
    const spatialTileCount = lods.reduce(
      (sum, item) => sum + item.tilesX * item.tilesY,
      0
    );
    console.log(`Wrote ${basename(out)} + ${spatialTileCount * chunks.length} timeline tiles: ` +
      `${(publishedBytes / 1024 / 1024).toFixed(2)} MiB published, ` +
      `${frames.length} frames (${historyHours}h history → ${forecastHours}h forecast), ` +
      `${(nativeDecodedBytes / 1024 / 1024).toFixed(2)} MiB native decoded, ` +
      `${(sourceBytes / 1024 / 1024).toFixed(2)} MiB source ranges`);
    return out;
  } finally {
    rmSync(work, { recursive:true, force:true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out') options.out = argv[++index];
    else if (arg === '--run') options.runMs = Date.parse(argv[++index]);
    else if (arg === '--anchor') options.anchorMs = Date.parse(argv[++index]);
    else if (arg === '--release-base-url') options.releaseBaseUrl = argv[++index];
    else if (arg === '--wgrib2') options.wgrib2 = argv[++index];
    else if (arg === '--history-hours') options.historyHours = +argv[++index];
    else if (arg === '--forecast-hours') options.forecastHours = +argv[++index];
    else if (arg === '--time-chunk-size') options.timeChunkSize = +argv[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  build(parseArguments(process.argv.slice(2))).catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

export { build, gridDefinition };
