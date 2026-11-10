/**
 * Spec 027 §3 "Image optimization" — the default optimizer (AC-2, §8 #10).
 *
 * STATED PLAINLY: it optimizes nothing. `optimize()` returns `{ optimized: false, reason:
 * 'no_optimizer' }` because this repository has no image-processing dependency and none is being
 * added. What it DOES supply is the delivery transform every public URL carries — a width cap and a
 * quality target expressed at delivery, which a configured CDN honours and an unconfigured one
 * simply ignores. Nothing here claims a resize happened.
 *
 * There is also no variants table: the MVP stores exactly one object per asset, and derivative
 * storage is a later spec's concern (§7).
 */
import type { ImageOptimizer, ImageTransform, OptimizeResult } from './types';

export const PASSTHROUGH_OPTIMIZER_NAME = 'passthrough';

/** §3: the width cap + quality AC-2 requires a public delivery URL to carry. */
export const DEFAULT_DELIVERY_TRANSFORM: ImageTransform = { width: 1600, quality: 80, format: 'auto' };

export function createPassthroughImageOptimizer(): ImageOptimizer {
  return {
    name: PASSTHROUGH_OPTIMIZER_NAME,

    async optimize(): Promise<OptimizeResult> {
      return { optimized: false, reason: 'no_optimizer' };
    },

    deliveryTransform(input: { mimeType: string }): ImageTransform {
      // Only a raster image has a meaningful width/quality transform; a PDF or MP4 gets none.
      return input.mimeType.startsWith('image/') ? { ...DEFAULT_DELIVERY_TRANSFORM } : {};
    },
  };
}
