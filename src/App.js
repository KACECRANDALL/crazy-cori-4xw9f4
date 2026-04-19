import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Download,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
} from "lucide-react";

// ---------------------------------------------------------------------------
// PRNG + hashing
// ---------------------------------------------------------------------------
function makePRNG(seed) {
  let s = seed >>> 0;
  return function rng() {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GRID_SIZE = 600; // base map size (tiles seamlessly)
const CELL_SIZE = 1;
const TARGET_FILL = 0.2;
const COASTLINE_ROUGHNESS = 0.18;

const DIRS4 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const DIRS8 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
const BIOMES = { MOUNTAIN: 0, PLAINS: 1, PLATEAU: 2 };

// ---------------------------------------------------------------------------
// Wrap helpers — ALL grid operations use these in wrap mode
// ---------------------------------------------------------------------------
const wrapV = (v, size) => ((v % size) + size) % size;
const wrapXY = (x, y, size) => [wrapV(x, size), wrapV(y, size)];

function wrapGet(grid, x, y) {
  const s = grid.length;
  return grid[wrapV(y, s)][wrapV(x, s)];
}
function wrapSet(grid, x, y, v) {
  const s = grid.length;
  grid[wrapV(y, s)][wrapV(x, s)] = v;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const shuffle = (arr, rng) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function makeGrid(size) {
  return Array.from({ length: size }, () => new Uint8Array(size));
}

// ---------------------------------------------------------------------------
// Value noise — wraps at map boundary for seamless tiling
// ---------------------------------------------------------------------------
function makeValueNoise(seed, mapSize, freq) {
  const rng = makePRNG(seed);
  const cells = Math.ceil(mapSize / freq) + 2;
  const table = new Float32Array(cells * cells);
  for (let i = 0; i < table.length; i++) table[i] = rng();

  return function sampleNoise(rawX, rawY) {
    // Wrap input coordinates so the noise field tiles at mapSize
    const wx = ((rawX % mapSize) + mapSize) % mapSize;
    const wy = ((rawY % mapSize) + mapSize) % mapSize;
    const gx = wx / freq;
    const gy = wy / freq;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const c = cells;
    const v00 = table[(y0 % c) * c + (x0 % c)];
    const v10 = table[(y0 % c) * c + ((x0 + 1) % c)];
    const v01 = table[((y0 + 1) % c) * c + (x0 % c)];
    const v11 = table[((y0 + 1) % c) * c + ((x0 + 1) % c)];
    return (
      v00 * (1 - ux) * (1 - uy) +
      v10 * ux * (1 - uy) +
      v01 * (1 - ux) * uy +
      v11 * ux * uy
    );
  };
}

// ---------------------------------------------------------------------------
// Landmass generation — fully wrapped
// ---------------------------------------------------------------------------
function recursiveBacktrack(grid, x, y, target, rng) {
  const size = grid.length;
  const stack = [[x, y]];
  let count = 0;
  while (stack.length && count < target) {
    const [cx, cy] = stack.pop();
    if (grid[cy][cx]) continue;
    grid[cy][cx] = 1;
    count++;
    if (count >= target) break;
    const cands = [];
    for (const [dx, dy] of DIRS4) {
      const [nx, ny] = wrapXY(cx + dx, cy + dy, size);
      if (!grid[ny][nx]) cands.push([nx, ny]);
    }
    for (const c of shuffle(cands, rng)) stack.push(c);
  }
}

function fillGaps(grid) {
  const size = grid.length;
  const out = grid.map((r) => r.slice());
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (out[y][x]) continue;
      let surrounded = true;
      for (const [dx, dy] of DIRS4) {
        if (!wrapGet(grid, x + dx, y + dy)) {
          surrounded = false;
          break;
        }
      }
      if (surrounded) out[y][x] = 1;
    }
  return out;
}

function isCoastal(grid, x, y) {
  if (!wrapGet(grid, x, y)) return false;
  for (const [dx, dy] of DIRS4) if (!wrapGet(grid, x + dx, y + dy)) return true;
  return false;
}

function roughenCoastlines(grid, rng) {
  const size = grid.length;
  const tmp = grid.map((r) => r.slice());
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (isCoastal(grid, x, y) && rng() < COASTLINE_ROUGHNESS) tmp[y][x] = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (!grid[y][x]) {
        let land = 0;
        for (const [dx, dy] of DIRS8) if (wrapGet(grid, x + dx, y + dy)) land++;
        if (land >= 4 && rng() < COASTLINE_ROUGHNESS * 0.5) tmp[y][x] = 1;
      }
  return tmp;
}

function removeThinLandmasses(grid) {
  const size = grid.length;
  const out = grid.map((r) => r.slice());
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (grid[y][x]) {
        let nb = 0;
        for (const [dx, dy] of DIRS4) if (wrapGet(grid, x + dx, y + dy)) nb++;
        if (nb <= 1) out[y][x] = 0;
      }
  return out;
}

function cellularSmooth(grid, iters = 3, threshold = { kill: 3, birth: 5 }) {
  let g = grid.map((r) => r.slice());
  const size = g.length;
  for (let i = 0; i < iters; i++) {
    const tmp = g.map((r) => r.slice());
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let nb = 0;
        for (const [dx, dy] of DIRS8) if (wrapGet(g, x + dx, y + dy)) nb++;
        if (g[y][x]) {
          if (nb < threshold.kill) tmp[y][x] = 0;
        } else {
          if (nb >= threshold.birth) tmp[y][x] = 1;
        }
      }
    g = tmp;
  }
  return g;
}

// In wrap mode all water is either a closed lake or the outer ocean.
// We treat any water blob larger than 3% of total cells as ocean (keep it),
// smaller blobs get filled as land.
function fillLargeLakes(grid, minSize = 50) {
  const size = grid.length;
  const total = size * size;
  const visited = new Uint8Array(total);
  const out = grid.map((r) => r.slice());

  for (let sy = 0; sy < size; sy++)
    for (let sx = 0; sx < size; sx++) {
      if (grid[sy][sx] || visited[sy * size + sx]) continue;
      const stack = [[sx, sy]];
      const lake = [];
      while (stack.length) {
        const [x, y] = stack.pop();
        if (visited[y * size + x] || grid[y][x]) continue;
        visited[y * size + x] = 1;
        lake.push([x, y]);
        for (const [dx, dy] of DIRS4) {
          const [nx, ny] = wrapXY(x + dx, y + dy, size);
          if (!visited[ny * size + nx]) stack.push([nx, ny]);
        }
      }
      // Fill small inland water pockets as land
      if (lake.length < total * 0.03)
        for (const [lx, ly] of lake) out[ly][lx] = 1;
    }
  return out;
}

function removeSmallIslands(grid, minSize = 40) {
  const size = grid.length;
  const visited = new Uint8Array(size * size);
  const out = grid.map((r) => r.slice());
  for (let sy = 0; sy < size; sy++)
    for (let sx = 0; sx < size; sx++) {
      if (!grid[sy][sx] || visited[sy * size + sx]) continue;
      const stack = [[sx, sy]];
      const island = [];
      let minX = sx,
        maxX = sx,
        minY = sy,
        maxY = sy;
      while (stack.length) {
        const [x, y] = stack.pop();
        if (visited[y * size + x] || !grid[y][x]) continue;
        visited[y * size + x] = 1;
        island.push([x, y]);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        for (const [dx, dy] of DIRS4) {
          const [nx, ny] = wrapXY(x + dx, y + dy, size);
          if (!visited[ny * size + nx]) stack.push([nx, ny]);
        }
      }
      const ar =
        Math.max(maxX - minX, maxY - minY) /
        Math.max(1, Math.min(maxX - minX, maxY - minY));
      if (island.length < minSize || ar > 8)
        for (const [ix, iy] of island) out[iy][ix] = 0;
    }
  return out;
}

// ---------------------------------------------------------------------------
// Elevation — wrapped BFS
// ---------------------------------------------------------------------------
function generateElevation(grid, rng) {
  const size = grid.length;
  const elevation = new Float32Array(size * size);
  const visited = new Uint8Array(size * size);
  const queue = [];

  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (isCoastal(grid, x, y)) {
        elevation[y * size + x] = 1;
        visited[y * size + x] = 1;
        queue.push(y * size + x);
      }

  const MAX_H = 80;
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const cx = idx % size;
    const cy = (idx / size) | 0;
    const curH = elevation[idx];
    for (const [dx, dy] of shuffle(DIRS4, rng)) {
      const [nx, ny] = wrapXY(cx + dx, cy + dy, size);
      if (!grid[ny][nx]) continue;
      const nIdx = ny * size + nx;
      const r = rng();
      const delta = r < 0.5 ? ((rng() * 3) | 0) + 1 : r < 0.7 ? 0 : -1;
      const nh = Math.max(1, Math.min(MAX_H, curH + delta));
      if (!visited[nIdx] || elevation[nIdx] < nh) {
        elevation[nIdx] = Math.max(elevation[nIdx], nh);
        if (!visited[nIdx]) {
          visited[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }
  }
  for (let i = 0; i < size * size; i++)
    if (grid[(i / size) | 0][i % size] && !elevation[i]) elevation[i] = 1;

  // Erosion passes
  for (let iter = 0; iter < 40; iter++) {
    const tmp = new Float32Array(elevation);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (!grid[y][x]) continue;
        let maxDrop = 0,
          best = -1;
        for (const [dx, dy] of DIRS4) {
          const [nx, ny] = wrapXY(x + dx, y + dy, size);
          const ni = ny * size + nx;
          if (grid[ny][nx]) {
            const drop = elevation[i] - elevation[ni];
            if (drop > maxDrop) {
              maxDrop = drop;
              best = ni;
            }
          }
        }
        if (maxDrop > 3) {
          const e = maxDrop * 0.15;
          tmp[i] -= e;
          if (best >= 0) tmp[best] += e * 0.4;
        }
      }
    elevation.set(tmp);
  }

  for (let iter = 0; iter < 15; iter++) {
    const tmp = new Float32Array(elevation);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (!grid[y][x]) continue;
        for (const [dx, dy] of DIRS4) {
          const [nx, ny] = wrapXY(x + dx, y + dy, size);
          const ni = ny * size + nx;
          if (grid[ny][nx]) {
            const diff = elevation[i] - elevation[ni];
            if (diff > 4) {
              const t = (diff - 4) * 0.5;
              tmp[i] -= t;
              tmp[ni] += t;
            }
          }
        }
      }
    elevation.set(tmp);
  }

  let maxE = 0;
  for (let i = 0; i < size * size; i++)
    if (grid[(i / size) | 0][i % size] && elevation[i] > maxE)
      maxE = elevation[i];
  if (maxE > 0) for (let i = 0; i < size * size; i++) elevation[i] /= maxE;
  return elevation;
}

// ---------------------------------------------------------------------------
// Biome map — wrapped flood fill
// ---------------------------------------------------------------------------
function generateBiomeMap(grid, rng, seedCount = 12) {
  const size = grid.length;
  const biomeMap = new Uint8Array(size * size);
  const seeds = [];
  while (seeds.length < seedCount) {
    const x = (rng() * size) | 0;
    const y = (rng() * size) | 0;
    if (!grid[y][x]) continue;
    const r = rng();
    seeds.push({
      x,
      y,
      biome:
        r < 0.6 ? BIOMES.MOUNTAIN : r < 0.85 ? BIOMES.PLAINS : BIOMES.PLATEAU,
    });
  }
  const queue = [];
  const visited = new Uint8Array(size * size);
  for (const s of seeds) {
    const i = s.y * size + s.x;
    biomeMap[i] = s.biome;
    visited[i] = 1;
    queue.push([s.x, s.y, s.biome]);
  }
  let head = 0;
  while (head < queue.length) {
    const [x, y, biome] = queue[head++];
    for (const [dx, dy] of DIRS4) {
      const [nx, ny] = wrapXY(x + dx, y + dy, size);
      if (!grid[ny][nx]) continue;
      const ni = ny * size + nx;
      if (visited[ni]) continue;
      visited[ni] = 1;
      biomeMap[ni] = biome;
      queue.push([nx, ny, biome]);
    }
  }
  return biomeMap;
}

function biomeScale(e, biome) {
  if (biome === BIOMES.PLAINS) return e * 0.2;
  if (biome === BIOMES.PLATEAU) {
    const c = Math.min(e, 0.6);
    return Math.pow(c / 0.6, 0.7) * 0.6;
  }
  return e;
}

function applyBiomeElevation(elevation, biomeMap, grid) {
  const size = grid.length;
  const BLEND_RADIUS = 18;
  const out = new Float32Array(elevation);
  for (let cy = 0; cy < size; cy++)
    for (let cx = 0; cx < size; cx++) {
      const i = cy * size + cx;
      if (!grid[cy][cx]) continue;
      const weights = [0, 0, 0];
      const r = BLEND_RADIUS;
      for (let dy = -r; dy <= r; dy++) {
        const [, ny] = wrapXY(0, cy + dy, size);
        for (let dx = -r; dx <= r; dx++) {
          const [nx] = wrapXY(cx + dx, 0, size);
          if (!grid[ny][nx]) continue;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > r) continue;
          const w = Math.exp(-(dist * dist) / (r * r * 0.3));
          weights[biomeMap[ny * size + nx]] += w;
        }
      }
      const total = weights[0] + weights[1] + weights[2];
      if (total === 0) continue;
      const e = elevation[i];
      out[i] =
        (weights[BIOMES.MOUNTAIN] * biomeScale(e, BIOMES.MOUNTAIN) +
          weights[BIOMES.PLAINS] * biomeScale(e, BIOMES.PLAINS) +
          weights[BIOMES.PLATEAU] * biomeScale(e, BIOMES.PLATEAU)) /
        total;
    }
  return out;
}

// ---------------------------------------------------------------------------
// Peaks & valleys (folded ridge noise)
// ---------------------------------------------------------------------------
function ridgeNoise(sample) {
  const n = sample * 2 - 1;
  return 1 - Math.abs(n);
}

function makePeaksAndValleys(seed, size) {
  const coarse = makeValueNoise(seed ^ 0xf00d, size, size / 5);
  const fine = makeValueNoise(seed ^ 0xbeef, size, size / 12);
  return (x, y) =>
    ridgeNoise(coarse(x, y)) * 0.7 + ridgeNoise(fine(x, y)) * 0.3;
}

function applyPeaksAndValleys(elevationF32, grid, seed, strength = 0.45) {
  const size = grid.length;
  const pv = makePeaksAndValleys(seed, size);
  const out = new Float32Array(elevationF32);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!grid[y][x]) continue;
      out[i] =
        elevationF32[i] + ridgeNoise(pv(x, y)) * strength * elevationF32[i];
    }
  // Re-normalize
  let maxE = 0;
  for (let i = 0; i < out.length; i++)
    if (grid[(i / size) | 0][i % size] && out[i] > maxE) maxE = out[i];
  if (maxE > 0)
    for (let i = 0; i < out.length; i++)
      if (grid[(i / size) | 0][i % size]) out[i] /= maxE;
  return out;
}

// ---------------------------------------------------------------------------
// Dither table (stable per seed)
// ---------------------------------------------------------------------------
function buildDitherTable(size, seed) {
  const rng = makePRNG(seed);
  const table = new Int8Array(size * size);
  for (let i = 0; i < table.length; i++) table[i] = (rng() * 8) | 0;
  return table;
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------
function elevationRGB(elev, v) {
  if (elev < 0.12) return [185 + v, 201 + v, 95 + v];
  if (elev < 0.28) return [144 + v, 200 + v, 120 + v];
  if (elev < 0.5) return [34 + v, 139 + v, 34 + v];
  if (elev < 0.7) return [22 + v, 107 + v, 22 + v];
  if (elev < 0.85) return [139 + v, 90 + v, 43 + v];
  return [220 + v, 220 + v, 220 + v];
}

// ---------------------------------------------------------------------------
// Render — supports viewport offset for the infinite pan illusion
// ---------------------------------------------------------------------------
function renderToCanvas(
  canvas,
  grid,
  elevationF32,
  zoom,
  showElevation,
  ditherTable,
  offsetX = 0,
  offsetY = 0
) {
  const size = grid.length;
  const cellH = Math.max(1, CELL_SIZE * zoom);
  const cellW = cellH;

  // How many grid cells fit in the viewport
  const vpW = Math.min(size, Math.ceil(canvas.width / cellW) + 1);
  const vpH = Math.min(size, Math.ceil(canvas.height / cellH) + 1);

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0a3060";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const imgData = ctx.createImageData(canvas.width, canvas.height);
  const px = imgData.data;

  for (let row = 0; row < vpH; row++) {
    for (let col = 0; col < vpW; col++) {
      // Wrap grid coordinates for seamless tiling
      const gx = wrapV(col + offsetX, size);
      const gy = wrapV(row + offsetY, size);
      const idx = gy * size + gx;
      const v = ditherTable ? ditherTable[idx % ditherTable.length] : 0;

      const pxX = Math.round(col * cellW);
      const pxY = Math.round(row * cellH);
      const pW = Math.round((col + 1) * cellW) - pxX;
      const pH = Math.round((row + 1) * cellH) - pxY;

      let r, g, b;
      if (!grid[gy][gx]) {
        r = 10;
        g = 48 + v;
        b = 96 + v;
      } else if (showElevation && elevationF32) {
        [r, g, b] = elevationRGB(elevationF32[idx], v);
      } else {
        r = 34 + v;
        g = 139 + v;
        b = 34 + v;
      }
      r = Math.max(0, Math.min(255, r));
      g = Math.max(0, Math.min(255, g));
      b = Math.max(0, Math.min(255, b));

      for (let py = pxY; py < pxY + pH && py < canvas.height; py++)
        for (let pc = pxX; pc < pxX + pW && pc < canvas.width; pc++) {
          const base = (py * canvas.width + pc) * 4;
          px[base] = r;
          px[base + 1] = g;
          px[base + 2] = b;
          px[base + 3] = 255;
        }
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------
function exportHeightmapPNG(grid, elevationF32) {
  const size = grid.length;
  const SCALE = 2;
  const outW = size * SCALE,
    outH = size * SCALE;
  const SEA = 128;
  const raw = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++)
    raw[i] = grid[(i / size) | 0][i % size]
      ? elevationF32
        ? elevationF32[i]
        : 0.5
      : -0.1;

  const off = document.createElement("canvas");
  off.width = outW;
  off.height = outH;
  const ctx = off.getContext("2d");
  const img = ctx.createImageData(outW, outH);
  const pxa = img.data;
  for (let py = 0; py < outH; py++)
    for (let px2 = 0; px2 < outW; px2++) {
      const f = raw[((py / SCALE) | 0) * size + ((px2 / SCALE) | 0)];
      const val = Math.round(
        Math.max(
          0,
          Math.min(
            255,
            f >= 0 ? SEA + f * (255 - SEA) * 0.5 : SEA * (1 + f / 0.1)
          )
        )
      );
      const b2 = (py * outW + px2) * 4;
      pxa[b2] = pxa[b2 + 1] = pxa[b2 + 2] = val;
      pxa[b2 + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  off.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "heightmap.png";
    a.click();
  }, "image/png");
}

function exportColoredPNG(sourceCanvas) {
  sourceCanvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "terrain_colored.png";
    a.click();
  }, "image/png");
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function analyzeContinents(grid) {
  const size = grid.length;
  const visited = new Uint8Array(size * size);
  let total = 0;
  for (let sy = 0; sy < size; sy++)
    for (let sx = 0; sx < size; sx++) {
      if (!grid[sy][sx] || visited[sy * size + sx]) continue;
      const stack = [[sx, sy]];
      let count = 0;
      while (stack.length) {
        const [x, y] = stack.pop();
        if (visited[y * size + x] || !grid[y][x]) continue;
        visited[y * size + x] = 1;
        count++;
        for (const [dx, dy] of DIRS4) {
          const [nx, ny] = wrapXY(x + dx, y + dy, size);
          if (!visited[ny * size + nx]) stack.push([nx, ny]);
        }
      }
      if (count > 10) total++;
    }
  return { total };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function TerrainGenerator() {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const [isGenerating, setIsGenerating] = useState(false);
  const [zoom, setZoom] = useState(2);
  const [showElevation, setShowElevation] = useState(true);
  const [pvStrength, setPvStrength] = useState(0.45);
  const [exportOpen, setExportOpen] = useState(false);
  const [stats, setStats] = useState({ total: 0, fill: 0 });
  const [seedMode, setSeedMode] = useState("fixed");
  const [seedInput, setSeedInput] = useState("");
  const [activeSeed, setActiveSeed] = useState(null);

  // Viewport offset in grid cells (for infinite pan)
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);

  const ditherTableRef = useRef(null);
  const lastGenRef = useRef({ grid: null, elevationF32: null });

  // Resize canvas to container
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ro = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      // Re-render with current data
      const { grid, elevationF32 } = lastGenRef.current;
      if (grid)
        renderToCanvas(
          canvas,
          grid,
          elevationF32,
          zoom,
          showElevation,
          ditherTableRef.current,
          offsetX,
          offsetY
        );
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [zoom, showElevation, offsetX, offsetY]);

  const generate = useCallback(
    (overrideSeed) => {
      setIsGenerating(true);
      setExportOpen(false);
      setTimeout(() => {
        let numericSeed;
        if (overrideSeed !== undefined) {
          numericSeed = overrideSeed;
        } else if (seedMode === "fixed" && seedInput.trim() !== "") {
          const asInt = parseInt(seedInput.trim(), 10);
          numericSeed =
            !isNaN(asInt) && String(asInt) === seedInput.trim()
              ? asInt >>> 0
              : hashSeed(seedInput.trim());
        } else {
          numericSeed = (Math.random() * 0xffffffff) >>> 0;
        }

        setActiveSeed(numericSeed);
        const rng = makePRNG(numericSeed);

        // Random start position so land clusters aren't always centered
        const startX = (rng() * GRID_SIZE) | 0;
        const startY = (rng() * GRID_SIZE) | 0;

        let grid = makeGrid(GRID_SIZE);
        const target = Math.floor(GRID_SIZE * GRID_SIZE * TARGET_FILL);
        recursiveBacktrack(grid, startX, startY, target, rng);
        grid = fillGaps(grid);
        grid = cellularSmooth(grid, 2, { kill: 3, birth: 5 });
        grid = roughenCoastlines(grid, rng);
        grid = removeThinLandmasses(grid);
        grid = fillLargeLakes(grid);
        grid = removeSmallIslands(grid, 40);
        grid = cellularSmooth(grid, 3, { kill: 4, birth: 6 });
        grid = fillGaps(grid);

        let elevationF32 = null;
        if (showElevation) {
          const biomeMap = generateBiomeMap(grid, rng, 14);
          elevationF32 = generateElevation(grid, rng);
          elevationF32 = applyBiomeElevation(elevationF32, biomeMap, grid);
          elevationF32 = applyPeaksAndValleys(
            elevationF32,
            grid,
            numericSeed,
            pvStrength
          );
        }

        ditherTableRef.current = buildDitherTable(
          GRID_SIZE,
          numericSeed ^ 0xd17eb3
        );
        lastGenRef.current = { grid, elevationF32 };

        const canvas = canvasRef.current;
        if (canvas) {
          renderToCanvas(
            canvas,
            grid,
            elevationF32,
            zoom,
            showElevation,
            ditherTableRef.current,
            offsetX,
            offsetY
          );
        }

        let land = 0;
        for (let y = 0; y < GRID_SIZE; y++)
          for (let x = 0; x < GRID_SIZE; x++) if (grid[y][x]) land++;
        const { total } = analyzeContinents(grid);
        setStats({
          total,
          fill: Math.round((land / (GRID_SIZE * GRID_SIZE)) * 100),
        });
        setIsGenerating(false);
      }, 50);
    },
    [zoom, showElevation, pvStrength, seedMode, seedInput, offsetX, offsetY]
  );

  // Re-render on pan/zoom without regenerating
  useEffect(() => {
    const { grid, elevationF32 } = lastGenRef.current;
    const canvas = canvasRef.current;
    if (!grid || !canvas) return;
    renderToCanvas(
      canvas,
      grid,
      elevationF32,
      zoom,
      showElevation,
      ditherTableRef.current,
      offsetX,
      offsetY
    );
  }, [offsetX, offsetY, zoom, showElevation]);

  useEffect(() => {
    generate();
  }, []);

  // Pan handlers — move by fraction of visible grid cells
  const pan = useCallback((dx, dy) => {
    setOffsetX((ox) => wrapV(ox + dx, GRID_SIZE));
    setOffsetY((oy) => wrapV(oy + dy, GRID_SIZE));
  }, []);

  // Keyboard pan
  useEffect(() => {
    const STEP = 8;
    const handler = (e) => {
      if (e.key === "ArrowLeft") pan(-STEP, 0);
      if (e.key === "ArrowRight") pan(STEP, 0);
      if (e.key === "ArrowUp") pan(0, -STEP);
      if (e.key === "ArrowDown") pan(0, STEP);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pan]);

  // Drag-to-pan
  const dragRef = useRef(null);
  const onMouseDown = (e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offsetX, oy: offsetY };
  };
  const onMouseMove = useCallback(
    (e) => {
      if (!dragRef.current) return;
      const cellPx = Math.max(1, CELL_SIZE * zoom);
      const dx = Math.round((dragRef.current.x - e.clientX) / cellPx);
      const dy = Math.round((dragRef.current.y - e.clientY) / cellPx);
      setOffsetX(wrapV(dragRef.current.ox + dx, GRID_SIZE));
      setOffsetY(wrapV(dragRef.current.oy + dy, GRID_SIZE));
    },
    [zoom]
  );
  const onMouseUp = () => {
    dragRef.current = null;
  };

  const handleExport = (type) => {
    const { grid, elevationF32 } = lastGenRef.current;
    if (!grid) return;
    if (type === "heightmap") exportHeightmapPNG(grid, elevationF32);
    else if (type === "colored") exportColoredPNG(canvasRef.current);
    setExportOpen(false);
  };

  const copySeed = () => {
    if (activeSeed !== null) navigator.clipboard.writeText(String(activeSeed));
  };
  const lockSeed = () => {
    if (activeSeed !== null) {
      setSeedInput(String(activeSeed));
      setSeedMode("fixed");
    }
  };

  const btn =
    "px-3 py-1.5 rounded text-xs font-medium transition-all duration-150 focus:outline-none";

  return (
    <div className="w-full h-screen flex flex-col bg-slate-950 font-mono select-none">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-slate-900 border-b border-slate-800 shrink-0">
        <div>
          <span className="text-sm font-bold text-slate-100 tracking-tight">
            Terrain
          </span>
          <span className="text-xs text-slate-500 ml-2">
            seamless wrap · peaks & valleys
          </span>
        </div>

        <div className="flex gap-1 ml-2">
          <span className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs border border-slate-700">
            {stats.fill}% land
          </span>
          <span className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs border border-slate-700">
            {stats.total} continents
          </span>
        </div>

        <div className="flex gap-1 ml-auto flex-wrap items-center">
          {/* Seed */}
          <div className="flex gap-1 p-0.5 bg-slate-800 rounded border border-slate-700">
            {[
              ["random", "🎲"],
              ["fixed", "📌"],
            ].map(([v, l]) => (
              <button
                key={v}
                onClick={() => setSeedMode(v)}
                className={`${btn} px-2 ${
                  seedMode === v
                    ? "bg-violet-600 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {l} {v}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={seedInput}
            onChange={(e) => setSeedInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isGenerating) generate();
            }}
            placeholder="seed…"
            disabled={seedMode === "random" || isGenerating}
            className="w-24 px-2 py-1 rounded text-xs border bg-slate-900 text-slate-200 placeholder-slate-600 border-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-30"
          />
          {activeSeed !== null && (
            <div className="flex items-center gap-1 text-xs">
              <span className="px-2 py-1 bg-slate-900 rounded border border-slate-700 text-violet-300 font-bold">
                {activeSeed}
              </span>
              <button
                onClick={copySeed}
                className={`${btn} border border-slate-700 hover:bg-slate-700 text-slate-400 hover:text-white`}
              >
                📋
              </button>
              <button
                onClick={lockSeed}
                className={`${btn} border border-slate-700 hover:bg-slate-700 text-slate-400 hover:text-white`}
              >
                🔒
              </button>
            </div>
          )}

          {/* Elevation toggle */}
          <button
            onClick={() => setShowElevation((e) => !e)}
            className={`${btn} border ${
              showElevation
                ? "bg-emerald-700 text-white border-emerald-600"
                : "bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700"
            }`}
          >
            🏔️ {showElevation ? "ON" : "OFF"}
          </button>

          {/* Peaks & valleys slider */}
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span>Ridges</span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={Math.round(pvStrength * 100)}
              onChange={(e) => setPvStrength(parseInt(e.target.value) / 100)}
              className="w-20"
            />
            <span className="w-6 text-slate-300">
              {Math.round(pvStrength * 100)}
            </span>
          </div>

          {/* Zoom */}
          <div className="flex items-center gap-1 p-0.5 bg-slate-800 rounded border border-slate-700">
            <button
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
              className={`${btn} text-slate-400 hover:text-white hover:bg-slate-700`}
            >
              <ZoomOut size={12} />
            </button>
            <span className="px-1 text-xs text-slate-300 w-10 text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(8, z + 0.25))}
              className={`${btn} text-slate-400 hover:text-white hover:bg-slate-700`}
            >
              <ZoomIn size={12} />
            </button>
          </div>

          {/* Regenerate */}
          <button
            onClick={() => generate()}
            disabled={isGenerating}
            className={`${btn} px-3 flex items-center gap-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white border border-green-600`}
          >
            <RotateCcw
              size={12}
              className={isGenerating ? "animate-spin" : ""}
            />
            {isGenerating ? "…" : "New"}
          </button>

          {/* Export */}
          <div className="relative">
            <button
              onClick={() => setExportOpen((o) => !o)}
              disabled={isGenerating}
              className={`${btn} px-3 flex items-center gap-1 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white border border-amber-600`}
            >
              <Download size={12} /> Export
            </button>
            {exportOpen && (
              <div className="absolute right-0 mt-1 z-20 w-44 bg-slate-800 border border-slate-600 rounded-lg shadow-xl overflow-hidden">
                {[
                  ["colored", "🖼️ Colored PNG"],
                  ["heightmap", "⬜ Heightmap PNG"],
                ].map(([k, l]) => (
                  <button
                    key={k}
                    onClick={() => handleExport(k)}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-slate-700 border-b border-slate-700 last:border-0 text-slate-200"
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Canvas — fills remaining space, drag to pan */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        {isGenerating && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-slate-950/70 text-slate-300 text-sm gap-3">
            <RotateCcw size={18} className="animate-spin" /> Generating terrain…
          </div>
        )}
        <canvas ref={canvasRef} className="block w-full h-full" />

        {/* Pan arrow buttons (corners) */}
        <div className="absolute bottom-4 right-4 grid grid-cols-3 gap-1 opacity-70 hover:opacity-100 transition-opacity">
          <div />
          <button
            onClick={() => pan(0, -8)}
            className="p-1.5 bg-slate-800 rounded border border-slate-600 text-slate-300 hover:bg-slate-700"
          >
            <ChevronUp size={14} />
          </button>
          <div />
          <button
            onClick={() => pan(-8, 0)}
            className="p-1.5 bg-slate-800 rounded border border-slate-600 text-slate-300 hover:bg-slate-700"
          >
            <ChevronLeft size={14} />
          </button>
          <div className="p-1.5 bg-slate-800/40 rounded border border-slate-700" />
          <button
            onClick={() => pan(8, 0)}
            className="p-1.5 bg-slate-800 rounded border border-slate-600 text-slate-300 hover:bg-slate-700"
          >
            <ChevronRight size={14} />
          </button>
          <div />
          <button
            onClick={() => pan(0, 8)}
            className="p-1.5 bg-slate-800 rounded border border-slate-600 text-slate-300 hover:bg-slate-700"
          >
            <ChevronDown size={14} />
          </button>
          <div />
        </div>

        {/* Coordinate readout */}
        <div className="absolute bottom-4 left-4 text-xs text-slate-500 bg-slate-900/70 px-2 py-1 rounded border border-slate-800">
          {offsetX}, {offsetY} · drag or arrow keys to pan
        </div>
      </div>
    </div>
  );
}
