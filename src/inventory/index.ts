/**
 * 背包层公开出口。
 *
 * I. 为什么提供 barrel
 *
 * 装配层（`src/app/GameApp.ts`）与 UI 只需要 `from '@/inventory'` 一行，
 * 避免每加一个文件就要改一遍 import 列表。内部模块之间仍然直接引用具体文件，
 * 这样依赖图里不会出现"一切都经过 barrel"的隐式环。
 *
 * @module inventory
 */

export * from './types';
export * from './Inventory';
export * from './ItemRegistry';
