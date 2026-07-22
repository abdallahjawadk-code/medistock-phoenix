export { PhoenixExperience, signalLoginIntent } from './PhoenixExperience';
export type { PhoenixVariant } from './PhoenixScene';
export { PhoenixWelcomeStage } from './PhoenixWelcomeStage';
export { preloadPhoenixWelcome } from './preload';
export {
  detectWebGL,
  prefersReducedMotion,
  prefersReducedData,
  shouldRenderWebGL,
  deviceHints,
  deviceTier,
  deviceProfile,
} from './webglSupport';
export type { DeviceTier, DeviceHints, DeviceProfile } from './webglSupport';
export {
  getEffectsMode,
  setEffectsMode,
  resolveEffects,
} from './effectsMode';
export type { EffectsMode, ResolvedEffects } from './effectsMode';
