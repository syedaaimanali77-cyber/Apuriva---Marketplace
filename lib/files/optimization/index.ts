/**
 * Spec 027 §3 "Image optimization" — optimizer selection.
 *
 * Unlike storage and scanning there is no production guard here, and deliberately so: the
 * passthrough optimizer makes NO claim that anything was optimized, so running it in production is
 * honest (images are served at their stored size with the delivery transform on the URL). A guard
 * would be theatre — the thing AC-11 protects against is a sandbox that pretends, and this one does
 * not pretend.
 */
import { createPassthroughImageOptimizer } from './passthrough';
import type { ImageOptimizer } from './types';

export type { ImageOptimizer, ImageTransform, OptimizeResult } from './types';
export {
  createPassthroughImageOptimizer,
  DEFAULT_DELIVERY_TRANSFORM,
  PASSTHROUGH_OPTIMIZER_NAME,
} from './passthrough';

export const IMAGE_OPTIMIZER_ENV_VAR = 'FILE_IMAGE_OPTIMIZER';

const OPTIMIZERS: Record<string, () => ImageOptimizer> = {
  passthrough: createPassthroughImageOptimizer,
};

/**
 * Not environment-selected today: `passthrough` is the only implementation and §9's eleven
 * variables deliberately do not include a twelfth for a choice that has one option. The registry
 * above is the seam a later spec adds its own entry to.
 */
export function resolveImageOptimizer(): ImageOptimizer {
  return OPTIMIZERS.passthrough!();
}
