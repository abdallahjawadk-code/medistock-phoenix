/**
 * PHARMA-OCR-A — non-destructive Canvas preprocessing.
 *
 * Every function returns a NEW buffer. The operator's original capture is never
 * overwritten: the review workspace keeps both and lets the operator compare,
 * because a preprocessing step that destroys a legible detail must remain
 * visible and reversible.
 *
 * Deliberately dependency-free — no OpenCV.js. That decision stands until a
 * measured prototype shows a material accuracy gain; see tools/ocr-eval.
 */

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PreprocessOptions {
  grayscale: boolean;
  normalizeContrast: boolean;
  sharpen: boolean;
  adaptiveThreshold: boolean;
  /** Degrees to rotate to correct measured skew; 0 or null disables deskew. */
  deskewDegrees: number | null;
}

export const DEFAULT_PREPROCESS: PreprocessOptions = {
  grayscale: true,
  normalizeContrast: true,
  sharpen: true,
  // Off by default: thresholding helps flat scans and actively HURTS uneven
  // phone captures by dropping faint strokes. Enabled per-image only when the
  // quality assessment indicates it is safe.
  adaptiveThreshold: false,
  deskewDegrees: null,
};

const clone = (image: RgbaImage): RgbaImage => ({
  data: new Uint8ClampedArray(image.data),
  width: image.width,
  height: image.height,
});

export function toGrayscale(image: RgbaImage): RgbaImage {
  const out = clone(image);
  for (let i = 0; i < out.data.length; i += 4) {
    const luma = 0.2126 * out.data[i] + 0.7152 * out.data[i + 1] + 0.0722 * out.data[i + 2];
    out.data[i] = luma;
    out.data[i + 1] = luma;
    out.data[i + 2] = luma;
  }
  return out;
}

/**
 * Percentile-clipped contrast stretch. Using the 1st/99th percentile rather
 * than absolute min/max keeps a single dust speck or specular dot from
 * defining the range and flattening the whole document.
 */
export function normalizeContrast(image: RgbaImage, clipPercent = 1): RgbaImage {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < image.data.length; i += 4) histogram[image.data[i] | 0] += 1;

  const totalPixels = image.width * image.height;
  const clipCount = Math.floor((totalPixels * clipPercent) / 100);

  let low = 0;
  let seen = 0;
  while (low < 255 && seen + histogram[low] <= clipCount) { seen += histogram[low]; low += 1; }

  let high = 255;
  seen = 0;
  while (high > 0 && seen + histogram[high] <= clipCount) { seen += histogram[high]; high -= 1; }

  const out = clone(image);
  if (high <= low) return out;

  const scale = 255 / (high - low);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      out.data[i + channel] = (out.data[i + channel] - low) * scale;
    }
  }
  return out;
}

/**
 * Restrained unsharp mask. `amount` is capped low on purpose: aggressive
 * sharpening manufactures edge artefacts that Tesseract reads as punctuation,
 * turning a clean batch number into a corrupted one.
 */
export function sharpen(image: RgbaImage, amount = 0.6): RgbaImage {
  const strength = Math.min(Math.max(amount, 0), 1);
  const out = clone(image);
  const { data, width, height } = image;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const c = index + channel;
        const neighbours =
          data[c - 4] + data[c + 4] + data[c - width * 4] + data[c + width * 4];
        // 5*center - 4*neighbours is the classic sharpen kernel; blending with
        // the original by `strength` keeps it from overshooting.
        const sharpened = 5 * data[c] - neighbours;
        out.data[c] = data[c] * (1 - strength) + sharpened * strength;
      }
    }
  }
  return out;
}

/**
 * Sauvola-style adaptive threshold over an integral image, so illumination
 * gradients (a phone shadow across one half of a box) do not erase text.
 */
export function adaptiveThreshold(image: RgbaImage, windowSize = 25, k = 0.2): RgbaImage {
  const { width, height } = image;
  const radius = Math.max(1, Math.floor(windowSize / 2));

  // Integral images of value and value² for O(1) window mean/variance.
  const area = (width + 1) * (height + 1);
  const sum = new Float64Array(area);
  const sumSquares = new Float64Array(area);

  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    let rowSumSquares = 0;
    for (let x = 0; x < width; x += 1) {
      const value = image.data[(y * width + x) * 4];
      rowSum += value;
      rowSumSquares += value * value;
      const index = (y + 1) * (width + 1) + (x + 1);
      sum[index] = sum[index - (width + 1)] + rowSum;
      sumSquares[index] = sumSquares[index - (width + 1)] + rowSumSquares;
    }
  }

  const out = clone(image);
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const count = (bottom - top + 1) * (right - left + 1);

      const a = top * (width + 1) + left;
      const b = top * (width + 1) + (right + 1);
      const c = (bottom + 1) * (width + 1) + left;
      const d = (bottom + 1) * (width + 1) + (right + 1);

      const windowSum = sum[d] - sum[b] - sum[c] + sum[a];
      const windowSumSquares = sumSquares[d] - sumSquares[b] - sumSquares[c] + sumSquares[a];
      const mean = windowSum / count;
      const variance = Math.max(0, windowSumSquares / count - mean * mean);
      const deviation = Math.sqrt(variance);

      const threshold = mean * (1 + k * (deviation / 128 - 1));
      const index = (y * width + x) * 4;
      const value = image.data[index] > threshold ? 255 : 0;
      out.data[index] = value;
      out.data[index + 1] = value;
      out.data[index + 2] = value;
    }
  }
  return out;
}

/**
 * Rotate by `degrees` about the centre with nearest-neighbour sampling onto a
 * white canvas of the same size. Only ever called with a skew angle the quality
 * pass could actually measure — an unmeasurable angle means no rotation, never
 * a guessed one.
 */
export function rotate(image: RgbaImage, degrees: number): RgbaImage {
  if (!Number.isFinite(degrees) || degrees === 0) return clone(image);

  const { width, height } = image;
  const out: RgbaImage = {
    data: new Uint8ClampedArray(width * height * 4).fill(255),
    width,
    height,
  };

  const radians = (-degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = width / 2;
  const centerY = height / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const sourceX = Math.round(centerX + dx * cos - dy * sin);
      const sourceY = Math.round(centerY + dx * sin + dy * cos);
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) continue;

      const target = (y * width + x) * 4;
      const source = (sourceY * width + sourceX) * 4;
      out.data[target] = image.data[source];
      out.data[target + 1] = image.data[source + 1];
      out.data[target + 2] = image.data[source + 2];
      out.data[target + 3] = image.data[source + 3];
    }
  }
  return out;
}

/** Apply the enabled steps in the order that preserves the most detail. */
export function preprocess(image: RgbaImage, options: PreprocessOptions = DEFAULT_PREPROCESS): RgbaImage {
  let current = clone(image);
  if (options.deskewDegrees !== null && options.deskewDegrees !== 0) {
    current = rotate(current, options.deskewDegrees);
  }
  if (options.grayscale) current = toGrayscale(current);
  if (options.normalizeContrast) current = normalizeContrast(current);
  if (options.sharpen) current = sharpen(current);
  // Thresholding is last: it is lossy and must see the fully-corrected image.
  if (options.adaptiveThreshold) current = adaptiveThreshold(current);
  return current;
}
