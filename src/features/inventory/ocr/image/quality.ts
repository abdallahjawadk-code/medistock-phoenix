/**
 * PHARMA-OCR-A — image quality assessment.
 *
 * Runs BEFORE recognition so an operator can retake a bad photo instead of
 * reviewing garbage fields. Every metric here is computed from real pixel
 * statistics on a downscaled grayscale copy — nothing is estimated or faked,
 * and each warning names the measured value so the assessment is explainable.
 *
 * Thresholds are documented, conservative starting points, not tuned constants:
 * they were chosen to catch obviously-unusable captures without nagging on
 * merely-imperfect ones. See tools/ocr-eval for how they are exercised.
 */

/**
 * NOT INCLUDED: perspective/keystone distortion. Measuring it reliably needs
 * document-quad detection (contour finding + corner ranking), which is exactly
 * the OpenCV.js dependency this phase declined to add without a measured
 * accuracy justification. Rather than ship a weak heuristic under a confident
 * name, perspective is left undetected — `edges_outside_frame` catches the
 * common severe case where a tilted document runs out of frame.
 */
export type QualityIssue =
  | 'blurry'
  | 'glare'
  | 'too_dark'
  | 'low_resolution'
  | 'edges_outside_frame'
  | 'rotated';

export type QualityVerdict = 'good' | 'usable' | 'poor';

export interface QualityFinding {
  issue: QualityIssue;
  /** The measured value that triggered this finding, for display. */
  measured: number;
  threshold: number;
}

export interface QualityAssessment {
  verdict: QualityVerdict;
  findings: QualityFinding[];
  metrics: {
    /** Variance of the Laplacian — the standard sharpness proxy. Higher is sharper. */
    sharpness: number;
    /** Fraction of pixels at/near full white. */
    blownHighlights: number;
    meanLuminance: number;
    width: number;
    height: number;
    /** Dominant text-line angle in degrees, or null when not measurable. */
    skewAngle: number | null;
  };
}

export const QUALITY_THRESHOLDS = {
  /** Laplacian variance below this reads as soft/out-of-focus. */
  sharpness: 120,
  /**
   * MEASURED CORRECTION. The original 0.06 was wrong by an order of magnitude:
   * it assumed a photographic scene, but a DOCUMENT is mostly white paper, so
   * the near-white fraction is naturally huge. Measured across the evaluation
   * corpus (tools/ocr-eval/fixtures):
   *
   *   clean scan   0.808 – 0.904
   *   mobile photo 0.937 – 0.970
   *   flash glare  0.969 – 0.986
   *
   * At 0.06 the warning fired on 100% of documents, including flawless scans —
   * a warning that always fires trains operators to ignore all warnings, which
   * is worse than having none. 0.95 separates glare from a clean scan on this
   * corpus.
   *
   * KNOWN WEAKNESS: a global near-white fraction is a weak glare proxy, because
   * real glare is a LOCAL blowout over text rather than a uniform brightening.
   * The margin between a mobile photo and genuine glare is thin, so this finding
   * is advisory only and never blocks recognition. A proper detector needs local
   * saturation analysis and is not attempted here.
   */
  blownHighlights: 0.95,
  /** Mean luminance (0–255) below this loses thin strokes entirely. */
  meanLuminance: 60,
  /** Text height gets unreliable below roughly this width for a document. */
  minWidth: 800,
  /** Beyond this many degrees, deskew is worth doing before OCR. */
  skewDegrees: 3,
} as const;

/** Downscaled working size — quality is a statistical judgement, not a pixel-exact one. */
const SAMPLE_MAX_EDGE = 800;

export interface GrayscaleSample {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Rec. 709 luma of an RGBA buffer, downscaled by an integer step. Pure and
 * synchronous so the metrics below are unit-testable without a canvas.
 */
export function toGrayscaleSample(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  maxEdge = SAMPLE_MAX_EDGE,
): GrayscaleSample {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / maxEdge));
  const outWidth = Math.floor(width / step);
  const outHeight = Math.floor(height / step);
  const out = new Float32Array(outWidth * outHeight);

  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const source = ((y * step) * width + (x * step)) * 4;
      out[y * outWidth + x] =
        0.2126 * rgba[source] + 0.7152 * rgba[source + 1] + 0.0722 * rgba[source + 2];
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

/**
 * Variance of the 4-neighbour Laplacian. A focused document has strong local
 * second derivatives at every glyph edge; a blurred one does not.
 */
export function laplacianVariance(sample: GrayscaleSample): number {
  const { data, width, height } = sample;
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const value =
        4 * data[index] - data[index - 1] - data[index + 1] - data[index - width] - data[index + width];
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

/** Fraction of pixels at or above `level` — flash glare and blown paper. */
export function blownHighlightRatio(sample: GrayscaleSample, level = 250): number {
  let blown = 0;
  for (let i = 0; i < sample.data.length; i += 1) {
    if (sample.data[i] >= level) blown += 1;
  }
  return sample.data.length === 0 ? 0 : blown / sample.data.length;
}

export function meanLuminance(sample: GrayscaleSample): number {
  if (sample.data.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < sample.data.length; i += 1) total += sample.data[i];
  return total / sample.data.length;
}

/**
 * Estimate document skew by projecting row-wise ink density at a set of
 * candidate angles and picking the angle whose projection has the highest
 * variance — text lines align when the projection is most peaked.
 *
 * Returns null rather than a guess when no angle is meaningfully better than
 * the others, so "unknown skew" is never reported as "zero skew".
 */
export function estimateSkewDegrees(
  sample: GrayscaleSample,
  maxDegrees = 8,
  stepDegrees = 0.5,
): number | null {
  const { data, width, height } = sample;
  if (width < 16 || height < 16) return null;

  // Binarize against the mean so "ink" is scale-independent.
  const threshold = meanLuminance(sample);
  let best = { angle: 0, score: -1 };
  let secondBestScore = -1;

  for (let angle = -maxDegrees; angle <= maxDegrees; angle += stepDegrees) {
    const radians = (angle * Math.PI) / 180;
    const tangent = Math.tan(radians);
    const buckets = new Float32Array(height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[y * width + x] >= threshold) continue;
        const projected = Math.round(y - (x - width / 2) * tangent);
        if (projected >= 0 && projected < height) buckets[projected] += 1;
      }
    }

    let sum = 0;
    let sumSquares = 0;
    for (let i = 0; i < height; i += 1) {
      sum += buckets[i];
      sumSquares += buckets[i] * buckets[i];
    }
    const mean = sum / height;
    const score = sumSquares / height - mean * mean;

    if (score > best.score) {
      secondBestScore = best.score;
      best = { angle, score };
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  // Require the winner to be distinctly better than the runner-up; a flat
  // response means there is no measurable dominant text direction.
  if (best.score <= 0 || secondBestScore <= 0) return null;
  if (best.score / secondBestScore < 1.02) return null;
  return best.angle;
}

/**
 * Fraction of ink touching the outer border, used as a proxy for "the document
 * runs off the edge of the frame". A scanned page on a contrasting background
 * has an essentially ink-free border.
 */
export function borderInkRatio(sample: GrayscaleSample, bandPx = 2): number {
  const { data, width, height } = sample;
  if (width <= bandPx * 2 || height <= bandPx * 2) return 0;
  const threshold = meanLuminance(sample) * 0.8;

  let ink = 0;
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onBorder = x < bandPx || y < bandPx || x >= width - bandPx || y >= height - bandPx;
      if (!onBorder) continue;
      total += 1;
      if (data[y * width + x] < threshold) ink += 1;
    }
  }
  return total === 0 ? 0 : ink / total;
}

/**
 * Combine the metrics into a verdict plus explainable findings.
 * `poor` means at least one hard blocker; `usable` means recognition will run
 * but the operator has been warned; `good` means no finding fired.
 */
export function assessQuality(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): QualityAssessment {
  const sample = toGrayscaleSample(rgba, width, height);
  const sharpness = laplacianVariance(sample);
  const blown = blownHighlightRatio(sample);
  const luminance = meanLuminance(sample);
  const skew = estimateSkewDegrees(sample);
  const borderInk = borderInkRatio(sample);

  const findings: QualityFinding[] = [];

  if (sharpness < QUALITY_THRESHOLDS.sharpness) {
    findings.push({ issue: 'blurry', measured: sharpness, threshold: QUALITY_THRESHOLDS.sharpness });
  }
  if (blown > QUALITY_THRESHOLDS.blownHighlights) {
    findings.push({ issue: 'glare', measured: blown, threshold: QUALITY_THRESHOLDS.blownHighlights });
  }
  if (luminance < QUALITY_THRESHOLDS.meanLuminance) {
    findings.push({ issue: 'too_dark', measured: luminance, threshold: QUALITY_THRESHOLDS.meanLuminance });
  }
  if (width < QUALITY_THRESHOLDS.minWidth) {
    findings.push({ issue: 'low_resolution', measured: width, threshold: QUALITY_THRESHOLDS.minWidth });
  }
  if (skew !== null && Math.abs(skew) > QUALITY_THRESHOLDS.skewDegrees) {
    findings.push({ issue: 'rotated', measured: skew, threshold: QUALITY_THRESHOLDS.skewDegrees });
  }
  if (borderInk > 0.35) {
    findings.push({ issue: 'edges_outside_frame', measured: borderInk, threshold: 0.35 });
  }

  // Blur and darkness genuinely prevent recognition; the rest degrade it.
  const hasBlocker = findings.some(f => f.issue === 'blurry' || f.issue === 'too_dark' || f.issue === 'low_resolution');
  const verdict: QualityVerdict = findings.length === 0 ? 'good' : hasBlocker ? 'poor' : 'usable';

  return {
    verdict,
    findings,
    metrics: {
      sharpness,
      blownHighlights: blown,
      meanLuminance: luminance,
      width,
      height,
      skewAngle: skew,
    },
  };
}
