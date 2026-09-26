import { describe, expect, it } from 'vitest';

import { BlockId } from '@/world/BlockRegistry';
import { World } from '@/world/World';
import { createTerrainGenerator } from '@/terrain/TerrainGenerator';

describe('seed scan', () => {
  it('generates chunks and counts water near the origin', () => {
    const lines: string[] = [];
    for (const seed of [1, 7, 42, 1337, 2024]) {
      const generator = createTerrainGenerator(seed, {});
      const world = new World({ seed, generator });
      let water = 0;
      let minDistance = Number.POSITIVE_INFINITY;
      let inNegZ = 0;
      for (let cx = -4; cx <= 4; cx += 1) {
        for (let cz = -4; cz <= 4; cz += 1) {
          const chunk = world.generateChunkNow(cx, cz);
          for (let lx = 0; lx < 16; lx += 1) {
            for (let lz = 0; lz < 16; lz += 1) {
              const wx = cx * 16 + lx;
              const wz = cz * 16 + lz;
              for (let y = 0; y < 90; y += 1) {
                if (chunk.getBlock(lx, y, lz) === BlockId.Water) {
                  water += 1;
                  minDistance = Math.min(minDistance, Math.hypot(wx, wz));
                  if (wz < 0) inNegZ += 1;
                  break;
                }
              }
            }
          }
        }
      }
      lines.push(
        `seed=${seed} waterBlocks=${water} nearest=${minDistance === Number.POSITIVE_INFINITY ? 'inf' : minDistance.toFixed(1)} negZWater=${inNegZ} spawnY=${generator.surfaceHeightAt(0, 0)} sea=${generator.options.seaLevel}`,
      );
    }
    console.warn(lines.join('\n'));
    expect(lines.length).toBe(5);
  });
});
