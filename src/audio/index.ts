/**
 * 音频子系统出口。
 *
 * 装配层只需要 `AudioManager`；`SoundBank` 的音效名与材质映射是交互层要用的，因此一并
 * 从这里导出，避免调用方深入子路径。
 *
 * @module audio
 */

export * from './audioTypes';
export * from './SoundBank';
export * from './AudioManager';
