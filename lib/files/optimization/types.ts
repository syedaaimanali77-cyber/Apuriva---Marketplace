/**
 * Spec 027 §3 "Image optimization" (AC-2) — the delivery/optimization port.
 *
 * No image-processing dependency exists in `package.json` and none is added (§8 #10). The default
 * `passthrough` optimizer therefore DECLINES to resize and says so, rather than claiming a resize
 * that never happened; what it does supply is the DELIVERY TRANSFORM the public URL carries, which
 * is how AC-2's "reasonable resizing/compression" is met honestly at this stage. A later adapter —
 * a CDN transform or a real library — implements `optimize()` behind this port and nothing else
 * changes.
 */
export interface ImageTransform {
  width?: number;
  quality?: number;
  format?: 'auto' | 'webp';
}

export type OptimizeResult =
  | { optimized: false; reason: string }
  | { optimized: true; storageKey: string; sizeBytes: number };

export interface ImageOptimizer {
  readonly name: string;
  /** May decline: a repository with no image library must say so rather than claim a resize. */
  optimize(input: { storageKey: string; mimeType: string; sizeBytes: number }): Promise<OptimizeResult>;
  /** The transform a delivery URL should carry for this kind of asset. */
  deliveryTransform(input: { mimeType: string }): ImageTransform;
}
