#!/usr/bin/env node
// Build native-grid browser wind tiles from NOAA's HRRR pressure product.
//
// This follows the cloud producer's data path: read the public .idx inventory,
// Range-fetch only the required GRIB messages, preserve the operational 3 km
// Lambert grid with wgrib2, and publish an exact 2x tile pyramid. U/V are kept
// as signed vector components; direction is never averaged or quantized.

import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  fetchByteRanges, parseIndex, parseNativeGrid, productUrl, resolveLatestRun, runParts
} from './build-hrrr-clouds.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'dist/hrrr-wind/hrrr-wind-manifest.js');
const SOURCE_PAGE = 'https://registry.opendata.aws/noaa-hrrr-pds/';
const RELEASE_BASE_URL =
  'https://github.com/ddv5725910/3DWeather-HRRR-Data/releases/download/hrrr-wind-data/';
const FETCH_ATTEMPTS = 4;
const FETCH_TIMEOUT_MS = 30_000;

export const LOD_COUNT = 6;
export const TILE_SIZE = 256;
export const WIND_SCALE = 0.1;
export const PRESSURE_LEVELS = Object.freeze([
  1000, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150
]);
export const LEVELS = Object.freeze([
  Object.freeze({ id:'10m', type:'height-agl', value:10, unit:'m', inventory:'10 m above ground' }),
  ...PRESSURE_LEVELS.map(value =>
    Object.freeze({ id:`${value}hPa`, type:'pressure', value, unit:'hPa', inventory:`${value} mb` })
  )
]);
export const VARIABLES = Object.freeze(['UGRD', 'VGRD']);

const wait = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

async function fetchText(url) {
  let lastError;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`request timeout ${FETCH_TIMEOUT_MS}ms`)),
      FETCH_TIMEOUT_MS
    );
    try {
      const response = await fetch(url, { signal:controller.signal });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${url}`);
        error.retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
        throw error;
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt + 1 >= FETCH_ATTEMPTS) break;
      await wait(Math.min(12_000, 750 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`HRRR index request failed: ${lastError?.message || url}`, { cause:lastError });
}

export function selectWindRecords(records) {
  const selected = [];
  for (const level of LEVELS) for (const variable of VARIABLES) {
    const token = `:${variable}:${level.inventory}:`;
    const record = records.find(item => item.line.includes(token));
    if (!record) throw new Error(`HRRR index is missing ${variable} at ${level.inventory}`);
    if (!Number.isFinite(record.end) || !Number.isFinite(record.bytes)) {
      throw new Error(`HRRR index has no byte boundary after ${variable} at ${level.inventory}`);
    }
    selected.push({ ...record, level, variable });
  }
  return selected;
}

export function coalesceWindRanges(selected) {
  const ranges = [];
  for (let index = 0; index < selected.length; index++) {
    const first = selected[index];
    const next = selected[index + 1];
    if (next && first.level.id === next.level.id && first.end + 1 === next.offset) {
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

function runWgrib2(executable, args, label) {
  const result = spawnSync(executable, args, { encoding:'utf8', maxBuffer:8 * 1024 * 1024 });
  if (result.error) throw new Error(`${label}: ${result.error.message}`, { cause:result.error });
  if (result.status !== 0) {
    throw new Error(`${label} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout || '';
}

export function validateWindInventory(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  const expected = [];
  for (let time = 0; time < 2; time++) for (const level of LEVELS) for (const variable of VARIABLES) {
    expected.push({ time, level, variable });
  }
  if (lines.length !== expected.length) {
    throw new Error(`Unexpected HRRR wind field count: ${lines.length}/${expected.length}`);
  }
  for (let index = 0; index < expected.length; index++) {
    const item = expected[index];
    if (!lines[index].includes(`:${item.variable}:${item.level.inventory}:`)) {
      throw new Error(`Unexpected HRRR wind field ${index + 1}: ${lines[index]}`);
    }
    const validTime = item.time === 0
      ? /:(?:anl|0 hour fcst):/.test(lines[index])
      : /:1 hour fcst:/.test(lines[index]);
    if (!validTime) throw new Error(`Unexpected HRRR wind valid time at field ${index + 1}`);
  }
  return true;
}

export function parseWindOrientation(text) {
  const match = String(text || '').match(/winds\(\s*([^)]+?)\s*\)/i);
  if (!match) throw new Error('HRRR wind grid metadata has no winds(...) orientation');
  const value = match[1].trim().toLowerCase();
  if (value === 'grid') return 'grid-relative';
  if (value === 'n/s' || value === 'earth') return 'earth-relative';
  throw new Error(`Unsupported HRRR wind orientation: winds(${match[1]})`);
}

function finiteWind(value) {
  return Number.isFinite(value) && Math.abs(value) < 1000;
}

function encodeWind(value) {
  const safe = finiteWind(value) ? value : 0;
  return Math.max(-32768, Math.min(32767, Math.round(safe / WIND_SCALE)));
}

export function packWindBinary(raw, grid) {
  const points = grid.nx * grid.ny;
  const fieldsPerTime = LEVELS.length * VARIABLES.length;
  const expectedBytes = 2 * fieldsPerTime * points * 4;
  if (raw.length !== expectedBytes) {
    throw new Error(`Unexpected wgrib2 wind binary size: ${raw.length}/${expectedBytes}`);
  }
  const values = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const samples = points * LEVELS.length;
  const packed = Buffer.allocUnsafe(samples * 8);
  for (let time = 0; time < 2; time++) for (let component = 0; component < 2; component++) {
    const targetBase = (time * 2 + component) * samples * 2;
    for (let level = 0; level < LEVELS.length; level++) {
      const field = time * fieldsPerTime + level * VARIABLES.length + component;
      const fieldBase = field * points;
      for (let point = 0; point < points; point++) {
        const sample = point * LEVELS.length + level;
        packed.writeInt16LE(encodeWind(values[fieldBase + point]), targetBase + sample * 2);
      }
    }
  }
  return packed;
}

function packedLayout(packed, grid) {
  const samples = grid.nx * grid.ny * LEVELS.length;
  if (packed.length !== samples * 8) {
    throw new Error(`Packed HRRR wind length does not match grid: ${packed.length}/${samples * 8}`);
  }
  return {
    samples,
    u0:0,
    v0:samples * 2,
    u1:samples * 4,
    v1:samples * 6
  };
}

export function downsampleWindGrid2x(packed, grid) {
  const source = packedLayout(packed, grid);
  const nx = Math.ceil(grid.nx / 2), ny = Math.ceil(grid.ny / 2);
  const targetGrid = { ...grid, nx, ny, dxM:grid.dxM * 2, dyM:grid.dyM * 2 };
  const targetSamples = nx * ny * LEVELS.length;
  const result = Buffer.alloc(targetSamples * 8);
  const blocks = [
    [source.u0, 0], [source.v0, targetSamples * 2],
    [source.u1, targetSamples * 4], [source.v1, targetSamples * 6]
  ];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    for (let level = 0; level < LEVELS.length; level++) {
      const targetSample = (y * nx + x) * LEVELS.length + level;
      for (const [sourceBase, targetBase] of blocks) {
        let sum = 0, count = 0;
        for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
          const sx = x * 2 + ox, sy = y * 2 + oy;
          if (sx >= grid.nx || sy >= grid.ny) continue;
          const sourceSample = (sy * grid.nx + sx) * LEVELS.length + level;
          sum += packed.readInt16LE(sourceBase + sourceSample * 2);
          count++;
        }
        result.writeInt16LE(Math.round(sum / Math.max(1, count)), targetBase + targetSample * 2);
      }
    }
  }
  return { packed:result, grid:targetGrid };
}

export function extractWindTile(packed, grid, tileX, tileY, tileSize = TILE_SIZE) {
  const source = packedLayout(packed, grid);
  const x0 = tileX * tileSize, y0 = tileY * tileSize;
  const nx = Math.max(0, Math.min(tileSize, grid.nx - x0));
  const ny = Math.max(0, Math.min(tileSize, grid.ny - y0));
  if (!nx || !ny) throw new Error(`Wind tile ${tileX},${tileY} is outside ${grid.nx}x${grid.ny}`);
  const samples = nx * ny * LEVELS.length;
  const result = Buffer.alloc(samples * 8);
  const blocks = [
    [source.u0, 0], [source.v0, samples * 2],
    [source.u1, samples * 4], [source.v1, samples * 6]
  ];
  for (const [sourceBase, targetBase] of blocks) {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const sourceSample = ((y0 + y) * grid.nx + x0 + x) * LEVELS.length;
      const targetSample = (y * nx + x) * LEVELS.length;
      packed.copy(
        result,
        targetBase + targetSample * 2,
        sourceBase + sourceSample * 2,
        sourceBase + (sourceSample + LEVELS.length) * 2
      );
    }
  }
  return { packed:result, x0, y0, nx, ny };
}

export function windTileSource(meta, packed) {
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
    scale:WIND_SCALE,
    encoding:'gzip+base64; u0:i16le,v0:i16le,u1:i16le,v1:i16le; point-major-level-minor',
    uncompressedBytes:packed.length,
    payload:gzipSync(packed, { level:9, mtime:0 }).toString('base64')
  };
  return `// Generated native HRRR wind tile; do not edit.\n` +
    `(function(g){var t=Object.freeze(${JSON.stringify(tile)});` +
    `if(typeof g.__acceptHrrrWindTile==="function")g.__acceptHrrrWindTile(t);` +
    `else(g.HRRR_WIND_TILE_QUEUE||(g.HRRR_WIND_TILE_QUEUE=[])).push(t);` +
    `})(typeof window!=="undefined"?window:globalThis);\n`;
}

export function windManifestSource(meta) {
  const manifest = {
    schemaVersion:2,
    source:'NOAA HRRR CONUS pressure product',
    sourceUrl:SOURCE_PAGE,
    product:'wrfprsf',
    generatedAt:meta.generatedAt,
    run:meta.run,
    validTimes:meta.validTimes,
    levels:LEVELS.map(({ inventory, ...level }) => level),
    variables:{ gridX:'UGRD', gridY:'VGRD' },
    windOrientation:meta.windOrientation,
    datasetId:meta.datasetId,
    projection:meta.projection,
    tileSize:meta.tileSize,
    lods:meta.lods,
    tileUrlTemplate:'hrrr-wind-l{lod}-x{x}-y{y}.js',
    releaseBaseUrl:meta.releaseBaseUrl || RELEASE_BASE_URL,
    nativeResolutionM:meta.projection.dxM,
    componentScale:WIND_SCALE,
    aggregation:'2x2-vector-component-mean'
  };
  return `// Generated native HRRR wind manifest; do not edit.\n` +
    `(function(g){g.HRRR_WIND_MANIFEST=Object.freeze(${JSON.stringify(manifest)});` +
    `})(typeof window!=="undefined"?window:globalThis);\n`;
}

async function build(options = {}) {
  const runMs = Number.isFinite(+options.runMs)
    ? +options.runMs
    : await resolveLatestRun({ onProbeError:(time, error) => {
      console.warn(`HRRR ${runParts(time).iso} unavailable: ${error.message}`);
    } });
  const work = mkdtempSync(resolve(tmpdir(), '3dweather-hrrr-wind-'));
  const miniGrib = resolve(work, 'selected-wind.grib2');
  const rawBin = resolve(work, 'wind-fields.bin');
  try {
    const pieces = [];
    let sourceBytes = 0;
    for (const forecastHour of [0, 1]) {
      const indexText = await fetchText(productUrl(runMs, forecastHour, '.idx'));
      const selected = selectWindRecords(parseIndex(indexText));
      const ranges = coalesceWindRanges(selected);
      console.log(`HRRR wind f${String(forecastHour).padStart(2, '0')}: ${ranges.length} ranges, ` +
        `${(ranges.reduce((sum, range) => sum + range.bytes, 0) / 1024 / 1024).toFixed(2)} MiB`);
      const buffers = await fetchByteRanges(productUrl(runMs, forecastHour), ranges);
      pieces.push(...buffers);
      sourceBytes += buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    }
    writeFileSync(miniGrib, Buffer.concat(pieces));

    const executable = options.wgrib2 || process.env.WGRIB2 || 'wgrib2';
    const gridText = runWgrib2(
      executable, [miniGrib, '-d', '1', '-grid'], 'wgrib2 wind grid inspection'
    );
    const projection = parseNativeGrid(gridText);
    const windOrientation = parseWindOrientation(gridText);
    validateWindInventory(runWgrib2(executable, [miniGrib, '-s'], 'wgrib2 wind inventory validation'));
    runWgrib2(executable, [
      miniGrib, '-order', 'we:sn', '-no_header', '-bin', rawBin
    ], 'wgrib2 wind binary export');

    const nativeGrid = {
      nx:projection.nx, ny:projection.ny, dxM:projection.dxM, dyM:projection.dyM
    };
    const packed = packWindBinary(readFileSync(rawBin), nativeGrid);
    const generatedAt = new Date().toISOString();
    const validTimes = [runMs, runMs + 3_600_000].map(value => new Date(value).toISOString());
    const out = resolve(options.out || DEFAULT_OUT), outDir = dirname(out);
    rmSync(outDir, { recursive:true, force:true });
    mkdirSync(outDir, { recursive:true });
    const parts = runParts(runMs);
    const datasetId = `${parts.day}${parts.hour}-${Date.parse(generatedAt)}`;
    const lods = [];
    let levelPacked = packed, levelGrid = nativeGrid, publishedBytes = 0;
    for (let lod = 0; lod < LOD_COUNT; lod++) {
      const tilesX = Math.ceil(levelGrid.nx / TILE_SIZE);
      const tilesY = Math.ceil(levelGrid.ny / TILE_SIZE);
      lods.push({
        lod,
        horizontalSizeM:projection.dxM * 2 ** lod,
        nx:levelGrid.nx,
        ny:levelGrid.ny,
        tilesX,
        tilesY
      });
      for (let tileY = 0; tileY < tilesY; tileY++) for (let tileX = 0; tileX < tilesX; tileX++) {
        const tile = extractWindTile(levelPacked, levelGrid, tileX, tileY, TILE_SIZE);
        const name = `hrrr-wind-l${lod}-x${tileX}-y${tileY}.js`;
        const source = windTileSource({
          datasetId, lod, tileX, tileY,
          x0:tile.x0, y0:tile.y0, nx:tile.nx, ny:tile.ny
        }, tile.packed);
        writeFileSync(resolve(outDir, name), source);
        publishedBytes += Buffer.byteLength(source);
      }
      if (lod + 1 < LOD_COUNT) {
        const next = downsampleWindGrid2x(levelPacked, levelGrid);
        levelPacked = next.packed;
        levelGrid = next.grid;
      }
    }
    const manifest = windManifestSource({
      generatedAt,
      run:parts.iso,
      validTimes,
      datasetId,
      projection,
      windOrientation,
      tileSize:TILE_SIZE,
      lods,
      releaseBaseUrl:options.releaseBaseUrl
    });
    const temporary = `${out}.tmp`;
    writeFileSync(temporary, manifest);
    renameSync(temporary, out);
    publishedBytes += Buffer.byteLength(manifest);
    console.log(`Wrote ${basename(out)} + ${lods.reduce((sum, item) => sum + item.tilesX * item.tilesY, 0)} tiles: ` +
      `${(publishedBytes / 1024 / 1024).toFixed(2)} MiB published, ` +
      `${(packed.length / 1024 / 1024).toFixed(2)} MiB native decoded, ` +
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
    else if (arg === '--release-base-url') options.releaseBaseUrl = argv[++index];
    else if (arg === '--wgrib2') options.wgrib2 = argv[++index];
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

export { build };
