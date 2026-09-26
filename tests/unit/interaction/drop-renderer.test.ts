/**
 * `DropRenderer` 单元测试：共享几何体、实例数量同步与释放。
 *
 * 说明：THREE 的 InstancedMesh/Matrix 运算不需要 WebGL 上下文，因此这些用例
 * 可以在 Node 环境里真实执行（而不是 mock 掉 Three.js）。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { DropRenderer } from '@/entities/DropRenderer';
import { ItemEntity } from '@/entities/ItemEntity';
import { BlockId } from '@/world/BlockRegistry';

function entities(count: number): ItemEntity[] {
  const list: ItemEntity[] = [];
  for (let i = 0; i < count; i += 1) {
    list.push(
      new ItemEntity({
        id: i + 1,
        item: i % 2 === 0 ? BlockId.Stone : BlockId.Dirt,
        count: 1,
        position: { x: i, y: 1.125, z: 0 },
      }),
    );
  }
  return list;
}

describe('DropRenderer', () => {
  it('几何体与材质全实例共享，容量固定', () => {
    const renderer = new DropRenderer({ capacity: 8 });
    expect(renderer.capacity).toBe(8);
    expect(renderer.geometry).toBeInstanceOf(THREE.BoxGeometry);

    const first = renderer.geometry;
    renderer.sync(entities(5));
    renderer.sync(entities(3));
    expect(renderer.geometry).toBe(first);
  });

  it('同步实例矩阵并把 instanceCount 设为可见数量', () => {
    const renderer = new DropRenderer({ capacity: 16 });
    expect(renderer.sync(entities(6))).toBe(6);
    expect(renderer.instanceCount).toBe(6);

    const mesh = renderer.object3d as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(5, matrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    expect(position.x).toBeCloseTo(5, 5);
    expect(scale.x).toBeCloseTo(1, 5);
  });

  it('超过容量的实体不会被绘制', () => {
    const renderer = new DropRenderer({ capacity: 4 });
    expect(renderer.sync(entities(10))).toBe(4);
    expect(renderer.instanceCount).toBe(4);
  });

  it('跳过已失效的实体', () => {
    const renderer = new DropRenderer({ capacity: 8 });
    const list = entities(3);
    const second = list[1];
    if (second !== undefined) {
      second.alive = false;
    }
    expect(renderer.sync(list)).toBe(2);
  });

  it('挂载到父节点并可释放', () => {
    const parent = new THREE.Group();
    const renderer = new DropRenderer({ parent, capacity: 4 });
    expect(parent.children).toContain(renderer.object3d);

    renderer.sync(entities(2));
    renderer.dispose();
    expect(parent.children).not.toContain(renderer.object3d);
    expect(renderer.instanceCount).toBe(0);
  });

  it('颜色写入实例颜色属性', () => {
    const renderer = new DropRenderer({ capacity: 4 });
    renderer.sync(entities(1));
    const mesh = renderer.object3d as THREE.InstancedMesh;
    expect(mesh.instanceColor).not.toBeNull();

    const color = new THREE.Color();
    mesh.getColorAt(0, color);
    // 石头侧面贴图的 baseColor；Three.js 会自动做 sRGB → 线性工作空间转换。
    const expected = new THREE.Color(0x8a8a8f);
    expect(color.r).toBeCloseTo(expected.r, 5);
    expect(color.g).toBeCloseTo(expected.g, 5);
  });
});
