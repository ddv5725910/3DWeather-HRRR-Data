import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import {
  LEVELS,
  TILE_SIZE,
  WIND_SCALE,
  coalesceWindRanges,
  downsampleWindGrid2x,
  extractWindTile,
  packWindBinary,
  parseWindOrientation,
  selectWindRecords,
  validateWindInventory,
  windManifestSource,
  windTileSource
} from '../scripts/build-hrrr-wind.mjs';
import { parseIndex } from '../scripts/build-hrrr-clouds.mjs';

function inventoryLines(forecast = 'anl') {
  let record = 1, offset = 0;
  const lines = [];
  for (const level of LEVELS) for (const variable of ['UGRD', 'VGRD']) {
    lines.push(`${record++}:${offset}:${variable}:${level.inventory}:${forecast}:`);
    offset += 10;
  }
  lines.push(`${record}:${offset}:TMP:surface:${forecast}:`);
  return lines;
}

test('selects ground 10 m and all pressure U/V records in renderer order', () => {
  const records = parseIndex(inventoryLines().join('\n'));
  const selected = selectWindRecords(records);
  assert.equal(selected.length, LEVELS.length * 2);
  assert.equal(selected[0].variable, 'UGRD');
  assert.equal(selected[0].level.id, '10m');
  assert.equal(selected[1].variable, 'VGRD');
  assert.equal(selected.at(-1).level.id, '150hPa');
  const ranges = coalesceWindRanges(selected);
  assert.equal(ranges.length, LEVELS.length);
  assert.ok(ranges.every(range => range.records.length === 2));
});

test('validates the two-time wgrib2 wind inventory', () => {
  const text = [
    ...inventoryLines('anl').slice(0, LEVELS.length * 2),
    ...inventoryLines('1 hour fcst').slice(0, LEVELS.length * 2)
  ].join('\n');
  assert.equal(validateWindInventory(text), true);
  assert.throws(
    () => validateWindInventory(text.replace(':VGRD:10 m above ground:', ':TMP:10 m above ground:')),
    /Unexpected HRRR wind field/
  );
});

test('detects whether GRIB wind components follow the Lambert grid or true north', () => {
  assert.equal(parseWindOrientation('grid_template=30:winds(grid):'), 'grid-relative');
  assert.equal(parseWindOrientation('grid_template=30:winds(N/S):'), 'earth-relative');
  assert.throws(() => parseWindOrientation('Lambert Conformal'), /no winds/);
});

test('packs field-major floats as point-major signed U/V components at 0.1 m/s', () => {
  const grid = { nx:2, ny:1 };
  const points = grid.nx * grid.ny;
  const fieldsPerTime = LEVELS.length * 2;
  const values = new Float32Array(2 * fieldsPerTime * points);
  for (let time = 0; time < 2; time++) for (let level = 0; level < LEVELS.length; level++) {
    for (let component = 0; component < 2; component++) for (let point = 0; point < points; point++) {
      const field = time * fieldsPerTime + level * 2 + component;
      values[field * points + point] = -20 + time * 10 + level + component * 0.5 + point * 0.1;
    }
  }
  const packed = packWindBinary(Buffer.from(values.buffer), grid);
  const samples = points * LEVELS.length;
  const sample = (point, level) => point * LEVELS.length + level;
  assert.equal(packed.length, samples * 8);
  assert.ok(Math.abs(packed.readInt16LE(sample(1, 3) * 2) * WIND_SCALE - -16.9) < 1e-9);
  assert.ok(Math.abs(packed.readInt16LE(samples * 2 + sample(0, 0) * 2) * WIND_SCALE - -19.5) < 1e-9);
  assert.ok(Math.abs(packed.readInt16LE(samples * 4 + sample(0, 0) * 2) * WIND_SCALE - -10) < 1e-9);
  assert.ok(Math.abs(packed.readInt16LE(samples * 6 + sample(1, 12) * 2) * WIND_SCALE - 2.6) < 1e-9);
});

test('2x LOD averages signed components and tile extraction preserves layout', () => {
  const grid = { nx:2, ny:2, dxM:3000, dyM:3000 };
  const samples = grid.nx * grid.ny * LEVELS.length;
  const packed = Buffer.alloc(samples * 8);
  const blocks = [0, samples * 2, samples * 4, samples * 6];
  for (let point = 0; point < 4; point++) for (let level = 0; level < LEVELS.length; level++) {
    const sample = point * LEVELS.length + level;
    for (let block = 0; block < blocks.length; block++) {
      packed.writeInt16LE(point * 4 + level + block, blocks[block] + sample * 2);
    }
  }
  const coarse = downsampleWindGrid2x(packed, grid);
  assert.deepEqual(
    { nx:coarse.grid.nx, ny:coarse.grid.ny, dxM:coarse.grid.dxM, dyM:coarse.grid.dyM },
    { nx:1, ny:1, dxM:6000, dyM:6000 }
  );
  assert.equal(coarse.packed.readInt16LE(0), 6);
  assert.equal(coarse.packed.readInt16LE(LEVELS.length * 2), 7);

  const tile = extractWindTile(packed, grid, 0, 0, TILE_SIZE);
  assert.equal(tile.nx, 2);
  assert.equal(tile.ny, 2);
  assert.deepEqual(tile.packed, packed);
});

test('manifest and tile scripts expose a self-describing native 3 km dataset', () => {
  const projection = {
    projection:'lambert-conformal',
    nx:1799,
    ny:1059,
    firstLat:21.138,
    firstLon:-122.72,
    orientationLon:-97.5,
    latitudeOfOrigin:38.5,
    standardParallel1:38.5,
    standardParallel2:38.5,
    dxM:3000,
    dyM:3000,
    earthRadiusM:6371229
  };
  const lods = Array.from({ length:6 }, (_, lod) => ({
    lod,
    horizontalSizeM:3000 * 2 ** lod,
    nx:Math.ceil(1799 / 2 ** lod),
    ny:Math.ceil(1059 / 2 ** lod),
    tilesX:Math.ceil(Math.ceil(1799 / 2 ** lod) / 256),
    tilesY:Math.ceil(Math.ceil(1059 / 2 ** lod) / 256)
  }));
  const context = { globalThis:null };
  context.globalThis = context;
  vm.runInNewContext(windManifestSource({
    generatedAt:'2026-07-19T05:10:00.000Z',
    run:'2026-07-19T05:00:00Z',
    validTimes:['2026-07-19T05:00:00Z', '2026-07-19T06:00:00Z'],
    datasetId:'fixture-wind',
    projection,
    windOrientation:'grid-relative',
    tileSize:256,
    lods
  }), context);
  assert.equal(context.HRRR_WIND_MANIFEST.levels[0].id, '10m');
  assert.equal(context.HRRR_WIND_MANIFEST.nativeResolutionM, 3000);
  assert.equal(context.HRRR_WIND_MANIFEST.windOrientation, 'grid-relative');
  assert.equal(context.HRRR_WIND_MANIFEST.aggregation, '2x2-vector-component-mean');

  const packed = Buffer.alloc(LEVELS.length * 8);
  packed.writeInt16LE(-123, 0);
  vm.runInNewContext(windTileSource({
    datasetId:'fixture-wind',
    lod:0,
    tileX:0,
    tileY:0,
    x0:0,
    y0:0,
    nx:1,
    ny:1
  }, packed), context);
  assert.equal(context.HRRR_WIND_TILE_QUEUE.length, 1);
  const tile = context.HRRR_WIND_TILE_QUEUE[0];
  assert.equal(tile.scale, 0.1);
  assert.deepEqual(gunzipSync(Buffer.from(tile.payload, 'base64')), packed);
});
