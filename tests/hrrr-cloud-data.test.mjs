import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';

import {
  LEVELS, VARIABLES, LOD_COUNT, TILE_SIZE,
  cloudManifestSource, cloudTileSource,
  cloudTimelineManifestSource, cloudTimelineTileSource,
  coalesceCloudRanges, condensateDensity,
  downsamplePackedGrid, downsamplePackedGrid2x, extractPackedTile, fetchByteRanges,
  downsampleTimelineFrame2x, extractTimelineFrameTile,
  gridDefinition, packRegriddedBinary, packTimelineFrameBinary,
  parseIndex, parseNativeGrid, productUrl, resolveLatestRun, timelineFrameSpecs,
  selectCloudRecords, snapshotSource, validateRegriddedInventory,
  validateTimelineFrameInventory
} from '../scripts/build-hrrr-clouds.mjs';

function syntheticIndex() {
  const lines = [];
  let record = 1, offset = 0;
  for (const level of LEVELS) {
    for (const variable of VARIABLES) {
      lines.push(`${record++}:${offset}:d=2026071705:${variable}:${level} mb:anl:`);
      offset += variable === 'HGT' ? 100 : 20;
    }
    lines.push(`${record++}:${offset}:d=2026071705:TMP:${level} mb:anl:`);
    offset += 50;
  }
  lines.push(`${record}:${offset}:d=2026071705:END:surface:anl:`);
  return { text:lines.join('\n'), bytes:offset + 10 };
}

test('HRRR index selection finds exactly the renderer fields and coalesces adjacent cloud water records', () => {
  const fixture = syntheticIndex();
  const records = parseIndex(fixture.text, fixture.bytes);
  const selected = selectCloudRecords(records);
  const ranges = coalesceCloudRanges(selected);
  assert.equal(selected.length, LEVELS.length * VARIABLES.length);
  assert.deepEqual(selected.slice(0, 3).map(item => [item.level, item.variable]), [
    [1000, 'HGT'], [1000, 'CLMR'], [1000, 'CIMIXR']
  ]);
  assert.equal(ranges.length, LEVELS.length * 2);
  assert.ok(ranges.every(range => range.records.length === 1 || (
    range.records[0].variable === 'CLMR' && range.records[1].variable === 'CIMIXR'
  )));
});

test('HRRR product URL uses the public NOAA Open Data S3 layout', () => {
  const run = Date.parse('2026-07-17T05:00:00Z');
  assert.equal(
    productUrl(run, 1, '.idx'),
    'https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20260717/conus/hrrr.t05z.wrfprsf01.grib2.idx'
  );
});

test('timeline is exactly wall-clock −12h through +18h while one complete run supplies forecasts', async () => {
  const anchor = Date.parse('2026-07-19T08:00:00Z');
  const forecastRun = Date.parse('2026-07-19T05:00:00Z');
  const frames = timelineFrameSpecs(anchor, 12, 18, 3, forecastRun);
  assert.equal(frames.length, 31);
  assert.equal(frames[0].validTime, '2026-07-18T20:00:00Z');
  assert.equal(frames[0].sourceRun, '2026-07-18T20:00:00Z');
  assert.equal(frames[0].forecastHour, 0);
  assert.equal(frames[12].validTime, '2026-07-19T08:00:00Z');
  assert.equal(frames[12].sourceRun, '2026-07-19T05:00:00Z');
  assert.equal(frames[12].forecastHour, 3);
  assert.equal(frames.at(-1).validTime, '2026-07-20T02:00:00Z');
  assert.equal(frames.at(-1).forecastHour, 21);
  assert.equal(new Set(frames.map(frame => frame.timeChunk)).size, 11);

  const probes = [];
  const resolved = await resolveLatestRun({
    now:Date.parse('2026-07-19T08:17:00Z'),
    requiredValidTime:Date.parse('2026-07-20T02:00:00Z'),
    fetchImpl:async url => {
      probes.push(url);
      const available = url.includes('hrrr.t06z.wrfprsf20.grib2.idx');
      return {
        ok:available,
        status:available ? 200 : 404,
        headers:{ get:() => null },
        text:async () => available
          ? ':HGT:1000 mb:anl:\n:CIMIXR:850 mb:anl:'
          : ''
      };
    },
    timeoutMs:100
  });
  assert.equal(resolved, Date.parse('2026-07-19T06:00:00Z'));
  assert.ok(probes[0].includes('hrrr.t07z.wrfprsf19.grib2.idx'));
  assert.ok(probes[1].includes('hrrr.t06z.wrfprsf20.grib2.idx'));
});

test('range downloader rejects a full-file response and validates exact byte boundaries', async () => {
  const range = { start:100, end:109, bytes:10 };
  await assert.rejects(
    fetchByteRanges('https://example.test/file', [range], {
      attempts:1,
      fetchImpl:async () => new Response(new Uint8Array(100), { status:200 })
    }),
    /accidental full-file download/
  );
  const result = await fetchByteRanges('https://example.test/file', [range], {
    attempts:1,
    fetchImpl:async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=100-109');
      return new Response(Uint8Array.from({ length:10 }, (_, index) => index), {
        status:206,
        headers:{ 'Content-Range':'bytes 100-109/1000' }
      });
    }
  });
  assert.deepEqual([...result[0]], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('cloud liquid plus cloud ice maps monotonically into visual density', () => {
  assert.equal(condensateDensity(0, 0), 0);
  assert.ok(condensateDensity(1e-5, 0) > 0);
  assert.ok(condensateDensity(7.5e-5, 0) >= 63);
  assert.ok(condensateDensity(3e-4, 0) > 95);
  assert.equal(condensateDensity(1e20, -5), 0);
});

test('regridded inventory must retain both times and exact field order', () => {
  const lines = [];
  let record = 1;
  for (let time = 0; time < 2; time++) for (const level of LEVELS) for (const variable of VARIABLES) {
    lines.push(`${record++}:0:d=2026071705:${variable}:${level} mb:${time ? '1 hour fcst' : 'anl'}:`);
  }
  assert.equal(validateRegriddedInventory(lines.join('\n')), true);
  const bad = lines.slice();
  [bad[0], bad[1]] = [bad[1], bad[0]];
  assert.throws(() => validateRegriddedInventory(bad.join('\n')), /Unexpected regridded field/);
});

test('regridded fields pack point-major time pairs with actual monotonic HRRR heights', () => {
  const grid = { nx:2, ny:1 };
  const points = grid.nx * grid.ny;
  const fields = 2 * LEVELS.length * VARIABLES.length;
  const values = new Float32Array(fields * points);
  for (let time = 0; time < 2; time++) for (let level = 0; level < LEVELS.length; level++) {
    const field = time * LEVELS.length * VARIABLES.length + level * VARIABLES.length;
    for (let point = 0; point < points; point++) {
      values[(field + 0) * points + point] = 100 + level * 800 + time * 10 + point;
      values[(field + 1) * points + point] = level === 2 ? 7.5e-5 : 0;
      values[(field + 2) * points + point] = point ? 2e-5 : 0;
    }
  }
  const raw = Buffer.from(values.buffer);
  const packed = packRegriddedBinary(raw, grid);
  const samples = points * LEVELS.length;
  assert.equal(packed.length, samples * 6);
  assert.equal(packed[2], 63);
  assert.ok(packed[LEVELS.length + 2] > packed[2]);
  assert.equal(packed[samples + 2], 63);
  assert.equal(packed.readUInt16LE(samples * 2 + 2 * 2), 1700);
  assert.equal(packed.readUInt16LE(samples * 4 + 2 * 2), 1710);
});

test('timeline chunks publish three frame-major density/height payloads', () => {
  const grid = { nx:2, ny:1, dxM:3000, dyM:3000 };
  const points = grid.nx * grid.ny;
  const fields = LEVELS.length * VARIABLES.length;
  const values = new Float32Array(fields * points);
  const inventory = [];
  for (let level = 0; level < LEVELS.length; level++) {
    const field = level * VARIABLES.length;
    for (let point = 0; point < points; point++) {
      values[field * points + point] = 120 + level * 850 + point;
      values[(field + 1) * points + point] = level === 1 ? 7.5e-5 : 0;
      values[(field + 2) * points + point] = point ? 1e-5 : 0;
    }
    for (const variable of VARIABLES) {
      inventory.push(`${inventory.length + 1}:0:d=2026071903:${variable}:${LEVELS[level]} mb:7 hour fcst:`);
    }
  }
  assert.equal(validateTimelineFrameInventory(inventory.join('\n'), 7), true);
  const packed = packTimelineFrameBinary(Buffer.from(values.buffer), grid);
  const samples = points * LEVELS.length;
  assert.equal(packed.length, samples * 3);
  assert.equal(packed[1], 63);
  assert.equal(packed.readUInt16LE(samples + 2), 970);
  assert.equal(downsampleTimelineFrame2x(packed, grid).grid.dxM, 6000);

  const tile = extractTimelineFrameTile(packed, grid, 0, 0, 2);
  const source = cloudTimelineTileSource({
    datasetId:'timeline-unit-test',
    timeChunk:'t00',
    frameIds:['v2026071903','v2026071904','v2026071905'],
    validTimes:[
      '2026-07-19T03:00:00Z',
      '2026-07-19T04:00:00Z',
      '2026-07-19T05:00:00Z'
    ],
    lod:0, tileX:0, tileY:0,
    x0:tile.x0, y0:tile.y0, nx:tile.nx, ny:tile.ny
  }, [tile.packed, tile.packed, tile.packed]);
  const context = { globalThis:{} };
  vm.runInNewContext(source, context);
  const published = context.globalThis.HRRR_CLOUD_TILE_QUEUE[0];
  assert.equal(published.schemaVersion, 3);
  assert.equal(published.frameIds.length, 3);
  assert.equal(
    gunzipSync(Buffer.from(published.payload, 'base64')).length,
    tile.packed.length * 3
  );
});

test('native HRRR Lambert metadata is retained at the operational 1799×1059 3 km grid', () => {
  const grid = parseNativeGrid(`
    Lambert Conformal: (1799 x 1059) input WE:SN output WE:SN res 56
    Lat1 21.138123 Lon1 237.280472 LoV 262.500000
    LatD 38.500000 Latin1 38.500000 Latin2 38.500000
    North Pole (1799 x 1059) Dx 3000.000000 m Dy 3000.000000 m
  `);
  assert.equal(grid.projection, 'lambert-conformal');
  assert.equal(grid.nx, 1799);
  assert.equal(grid.ny, 1059);
  assert.equal(grid.dxM, 3000);
  assert.equal(grid.dyM, 3000);
  assert.ok(Math.abs(grid.firstLon + 122.719528) < 1e-10);
  assert.equal(grid.orientationLon, -97.5);
});

test('six-level native pyramid uses unbiased 2×2 means and exact 3→96 km spacing', () => {
  let grid = { nx:4, ny:4, dxM:3000, dyM:3000 };
  const samples = grid.nx * grid.ny * LEVELS.length;
  let packed = Buffer.alloc(samples * 6);
  for (let point = 0; point < grid.nx * grid.ny; point++) {
    for (let level = 0; level < LEVELS.length; level++) {
      const sample = point * LEVELS.length + level;
      packed[sample] = point;
      packed[samples + sample] = point + 10;
      packed.writeUInt16LE(1000 + point, samples * 2 + sample * 2);
      packed.writeUInt16LE(2000 + point, samples * 4 + sample * 2);
    }
  }
  const sizes = [];
  for (let lod = 0; lod < LOD_COUNT; lod++) {
    sizes.push(grid.dxM);
    if (lod + 1 < LOD_COUNT) {
      const next = downsamplePackedGrid2x(packed, grid);
      packed = next.packed;
      grid = next.grid;
    }
  }
  assert.deepEqual(sizes, [3000, 6000, 12000, 24000, 48000, 96000]);
  // First 2×2 source points are 0,1,4,5: their area mean rounds to 3.
  const first = downsamplePackedGrid2x(
    (() => {
      const sourceGrid = { nx:4, ny:4, dxM:3000, dyM:3000 };
      const sourceSamples = sourceGrid.nx * sourceGrid.ny * LEVELS.length;
      const source = Buffer.alloc(sourceSamples * 6);
      for (let point = 0; point < 16; point++) for (let level = 0; level < LEVELS.length; level++) {
        const sample = point * LEVELS.length + level;
        source[sample] = point;
        source[sourceSamples + sample] = point;
        source.writeUInt16LE(1000 + point, sourceSamples * 2 + sample * 2);
        source.writeUInt16LE(1000 + point, sourceSamples * 4 + sample * 2);
      }
      return source;
    })(),
    { nx:4, ny:4, dxM:3000, dyM:3000 }
  );
  assert.equal(first.packed[0], 3);
  assert.equal(first.packed.readUInt16LE(first.grid.nx * first.grid.ny * LEVELS.length * 2), 1003);
});

test('native tiles contain only their requested rectangle and manifest advertises six LODs', () => {
  const grid = { nx:3, ny:2, dxM:3000, dyM:3000 };
  const samples = grid.nx * grid.ny * LEVELS.length;
  const packed = Buffer.alloc(samples * 6);
  for (let point = 0; point < 6; point++) for (let level = 0; level < LEVELS.length; level++) {
    const sample = point * LEVELS.length + level;
    packed[sample] = point * 10 + level;
  }
  const tile = extractPackedTile(packed, grid, 1, 0, 2);
  assert.deepEqual({ x0:tile.x0, y0:tile.y0, nx:tile.nx, ny:tile.ny }, {
    x0:2, y0:0, nx:1, ny:2
  });
  assert.equal(tile.packed[0], 20);
  assert.equal(tile.packed[LEVELS.length], 50);

  const datasetId = '2026071805-test';
  const tileContext = { globalThis:{} };
  vm.runInNewContext(cloudTileSource({
    datasetId, lod:0, tileX:1, tileY:0, ...tile
  }, tile.packed), tileContext);
  assert.equal(tileContext.globalThis.HRRR_CLOUD_TILE_QUEUE[0].datasetId, datasetId);

  const projection = {
    projection:'lambert-conformal', nx:1799, ny:1059,
    dxM:3000, dyM:3000, firstLat:21.138123, firstLon:-122.719528,
    orientationLon:-97.5, latitudeOfOrigin:38.5,
    standardParallel1:38.5, standardParallel2:38.5, earthRadiusM:6371229
  };
  const lods = Array.from({ length:LOD_COUNT }, (_, lod) => ({
    lod,
    horizontalSizeM:3000 * 2 ** lod,
    nx:Math.ceil(1799 / 2 ** lod),
    ny:Math.ceil(1059 / 2 ** lod),
    tilesX:Math.ceil(Math.ceil(1799 / 2 ** lod) / TILE_SIZE),
    tilesY:Math.ceil(Math.ceil(1059 / 2 ** lod) / TILE_SIZE)
  }));
  const manifestContext = { globalThis:{} };
  vm.runInNewContext(cloudManifestSource({
    generatedAt:'2026-07-18T06:10:00Z',
    run:'2026-07-18T05:00:00Z',
    validTimes:['2026-07-18T05:00:00Z', '2026-07-18T06:00:00Z'],
    datasetId, projection, tileSize:TILE_SIZE, lods
  }), manifestContext);
  assert.deepEqual(
    [...manifestContext.globalThis.HRRR_CLOUD_MANIFEST.lods].map(item => item.horizontalSizeM),
    [3000, 6000, 12000, 24000, 48000, 96000]
  );
});

test('first-paint preview preserves all levels and times on an exact coarser grid', () => {
  const grid = { west:-3, south:0, east:0, north:3, resolution:1, nx:4, ny:4 };
  const samples = grid.nx * grid.ny * LEVELS.length;
  const packed = Buffer.alloc(samples * 6);
  for (let index = 0; index < samples; index++) {
    packed[index] = index % 251;
    packed[samples + index] = (index + 17) % 251;
    packed.writeUInt16LE(1000 + index, samples * 2 + index * 2);
    packed.writeUInt16LE(2000 + index, samples * 4 + index * 2);
  }
  const preview = downsamplePackedGrid(packed, grid, 3);
  assert.deepEqual(preview.grid, {
    west:-3, south:0, east:0, north:3, resolution:3, nx:2, ny:2
  });
  const previewSamples = 2 * 2 * LEVELS.length;
  assert.equal(preview.packed.length, previewSamples * 6);
  assert.equal(preview.packed[LEVELS.length], packed[3 * LEVELS.length]);
  assert.equal(
    preview.packed.readUInt16LE(previewSamples * 4 + (3 * LEVELS.length + 2) * 2),
    packed.readUInt16LE(samples * 4 + (15 * LEVELS.length + 2) * 2)
  );
});

test('snapshot is a valid classic script carrying a deterministic gzip payload', () => {
  const grid = { ...gridDefinition({ west:-1, east:0, south:0, north:1, resolution:1 }) };
  const samples = grid.nx * grid.ny * LEVELS.length;
  const packed = Buffer.alloc(samples * 6, 7);
  const source = snapshotSource({
    generatedAt:'2026-07-17T06:00:00.000Z',
    run:'2026-07-17T05:00:00Z',
    validTimes:['2026-07-17T05:00:00Z', '2026-07-17T06:00:00Z'],
    grid
  }, packed);
  const context = { globalThis:{} };
  vm.runInNewContext(source, context);
  const snapshot = context.globalThis.HRRR_CLOUD_DATA;
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.source, 'NOAA HRRR CONUS pressure product');
  assert.equal(snapshot.preview, false);
  assert.deepEqual(gunzipSync(Buffer.from(snapshot.payload, 'base64')), packed);
});
