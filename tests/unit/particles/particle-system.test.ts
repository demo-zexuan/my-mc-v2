/**
 * `ParticleSystem` 单元测试：定长池、过期回收、共享渲染资源、事件驱动。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { EventBus } from '@/engine/events/EventBus';
import { ParticleSystem } from '@/particles/ParticleSystem';
import { BlockId } from '@/world/BlockRegistry';

describe('ParticleSystem 对象池', () => {
  it('默认容量 512 且初始为空', () => {
    const particles = new ParticleSystem();
    expect(particles.capacity).toBe(512);
    expect(particles.activeCount).toBe(0);
    expect(particles.spawnedTotal).toBe(0);
    particles.dispose();
  });

  it('burst 生成指定数量的粒子', () => {
    const particles = new ParticleSystem({ capacity: 64 });
    const spawned = particles.burst({ x: 0, y: 0, z: 0 }, { count: 12, color: 0xffffff });

    expect(spawned).toBe(12);
    expect(particles.activeCount).toBe(12);
    expect(particles.spawnedTotal).toBe(12);
    particles.dispose();
  });

  it('池满时覆盖旧粒子而不是扩容', () => {
    const particles = new ParticleSystem({ capacity: 32 });

    const spawned = particles.burst({ x: 0, y: 0, z: 0 }, { count: 5000, color: 0x00ff00 });

    expect(spawned).toBe(5000);
    expect(particles.capacity).toBe(32);
    expect(particles.activeCount).toBe(32);
    expect(particles.activeCount).toBeLessThanOrEqual(particles.capacity);
    particles.dispose();
  });

  it('寿命结束后回收槽位并可再次使用', () => {
    const particles = new ParticleSystem({ capacity: 16 });
    particles.burst({ x: 1, y: 2, z: 3 }, { count: 10, color: 0xffffff });
    expect(particles.activeCount).toBe(10);

    particles.update(0.05);
    expect(particles.activeCount).toBe(10);

    particles.update(5);
    expect(particles.activeCount).toBe(0);

    particles.burst({ x: 0, y: 0, z: 0 }, { count: 8, color: 0xff0000 });
    expect(particles.activeCount).toBe(8);
    expect(particles.spawnedTotal).toBe(18);
  });

  it('update 把网格实例数同步为活跃粒子数', () => {
    const particles = new ParticleSystem({ capacity: 16 });
    const mesh = particles.object3d as THREE.InstancedMesh;

    particles.burst({ x: 0, y: 0, z: 0 }, { count: 5, color: 0xffffff });
    particles.update(1 / 60);
    expect(mesh.count).toBe(5);

    particles.update(5);
    expect(mesh.count).toBe(0);
    particles.dispose();
  });

  it('非法 count 与非法 delta 不会破坏池', () => {
    const particles = new ParticleSystem({ capacity: 8 });
    expect(particles.burst({ x: 0, y: 0, z: 0 }, { count: 0, color: 0 })).toBe(0);
    expect(particles.burst({ x: 0, y: 0, z: 0 }, { count: -3, color: 0 })).toBe(0);
    expect(particles.burst({ x: 0, y: 0, z: 0 }, { count: Number.NaN, color: 0 })).toBe(0);

    particles.burst({ x: 0, y: 0, z: 0 }, { count: 4, color: 0 });
    particles.update(Number.NaN);
    particles.update(-1);
    expect(particles.activeCount).toBe(4);
    particles.dispose();
  });

  it('clear 回收全部粒子', () => {
    const particles = new ParticleSystem({ capacity: 8 });
    particles.burst({ x: 0, y: 0, z: 0 }, { count: 8, color: 0 });
    particles.clear();
    expect(particles.activeCount).toBe(0);
    particles.dispose();
  });
});

describe('ParticleSystem 渲染资源', () => {
  it('几何体与网格跨帧复用（不重建）', () => {
    const particles = new ParticleSystem({ capacity: 32 });
    const geometry = particles.geometry;
    const mesh = particles.object3d as THREE.InstancedMesh;

    for (let frame = 0; frame < 30; frame += 1) {
      particles.burst({ x: frame, y: 0, z: 0 }, { count: 20, color: 0x8899aa });
      particles.update(1 / 60);
    }

    expect(particles.geometry).toBe(geometry);
    expect(particles.object3d).toBe(mesh);
    expect(mesh.geometry).toBe(geometry);
    expect(particles.capacity).toBe(32);
    particles.dispose();
  });

  it('挂到父节点并可释放', () => {
    const parent = new THREE.Group();
    const particles = new ParticleSystem({ parent, capacity: 4 });
    expect(parent.children).toContain(particles.object3d);

    particles.dispose();
    expect(parent.children).not.toContain(particles.object3d);
    expect(particles.activeCount).toBe(0);
  });

  it('粒子颜色来自实例颜色属性', () => {
    const particles = new ParticleSystem({ capacity: 8 });
    particles.burst({ x: 0, y: 0, z: 0 }, { count: 4, color: 0xffd98a });
    particles.update(1 / 60);

    const mesh = particles.object3d as THREE.InstancedMesh;
    expect(mesh.instanceColor).not.toBeNull();

    const color = new THREE.Color();
    mesh.getColorAt(0, color);
    const expected = new THREE.Color(0xffd98a);
    expect(color.r).toBeCloseTo(expected.r, 5);
    expect(color.g).toBeCloseTo(expected.g, 5);
    expect(color.b).toBeCloseTo(expected.b, 5);
    particles.dispose();
  });
});

describe('ParticleSystem 与事件总线联动', () => {
  it('破坏方块时按方块主色生成粒子', () => {
    const bus = new EventBus();
    const particles = new ParticleSystem({ bus, capacity: 64 });

    bus.emit('block:broken', { x: 3, y: 4, z: 5, block: BlockId.Stone });
    expect(particles.activeCount).toBe(12);

    bus.emit('block:broken', { x: 3, y: 4, z: 5, block: BlockId.Dirt });
    expect(particles.activeCount).toBe(24);
    particles.dispose();
  });

  it('放置方块时生成较少的反馈粒子', () => {
    const bus = new EventBus();
    const particles = new ParticleSystem({ bus, capacity: 64 });

    bus.emit('block:placed', { x: 0, y: 0, z: 0, block: BlockId.Planks });
    expect(particles.activeCount).toBe(6);
    particles.dispose();
  });

  it('dispose 后不再响应事件', () => {
    const bus = new EventBus();
    const particles = new ParticleSystem({ bus, capacity: 64 });
    particles.dispose();

    bus.emit('block:broken', { x: 0, y: 0, z: 0, block: BlockId.Stone });
    expect(particles.activeCount).toBe(0);
  });
});

describe('ParticleSystem 确定性', () => {
  it('同种子产生相同的粒子轨迹', () => {
    const a = new ParticleSystem({ capacity: 16, seed: 7 });
    const b = new ParticleSystem({ capacity: 16, seed: 7 });

    a.emitBlockBreak(0, 0, 0, BlockId.Stone);
    b.emitBlockBreak(0, 0, 0, BlockId.Stone);
    for (let frame = 0; frame < 10; frame += 1) {
      a.update(1 / 60);
      b.update(1 / 60);
    }

    const matrixA = new THREE.Matrix4();
    const matrixB = new THREE.Matrix4();
    const meshA = a.object3d as THREE.InstancedMesh;
    const meshB = b.object3d as THREE.InstancedMesh;
    for (let i = 0; i < meshA.count; i += 1) {
      meshA.getMatrixAt(i, matrixA);
      meshB.getMatrixAt(i, matrixB);
      expect(matrixA.elements).toEqual(matrixB.elements);
    }
    expect(meshA.count).toBeGreaterThan(0);

    a.dispose();
    b.dispose();
  });
});
