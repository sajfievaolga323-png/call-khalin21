/**
 * Приводит маску MediaPipe к чистому альфа-каналу (белый цвет, alpha = «это человек»).
 * Разные сборки библиотеки отдают маску по-разному: в alpha-канале или в красном канале
 * (при сплошном alpha) — поддерживаем оба варианта. Правка идёт «на месте».
 * Возвращает долю кадра, занятую человеком (0..1).
 */
export function maskToAlpha(img: { data: Uint8ClampedArray }): number {
  const px = img.data;
  let aMin = 255;
  let aMax = 0;
  for (let i = 3; i < px.length; i += 4) {
    const a = px[i];
    if (a < aMin) aMin = a;
    if (a > aMax) aMax = a;
  }
  const useAlpha = aMax - aMin > 24;
  let covered = 0;
  for (let i = 0; i < px.length; i += 4) {
    let a = useAlpha ? px[i + 3] : px[i];
    a = a <= 80 ? 0 : a >= 176 ? 255 : ((a - 80) * 255) / 96; // мягкий порог: чёткий контур без «лесенки»
    if (a > 128) covered++;
    px[i] = px[i + 1] = px[i + 2] = 255;
    px[i + 3] = a;
  }
  return covered / (px.length / 4);
}

type FloatMask = { data: Float32Array; width: number; height: number };

/**
 * Выбирает из масок MediaPipe Tasks ту, где «человек», и возвращает RGBA-картинку (alpha = вероятность).
 * Какая из масок «человек» и не перевёрнута ли она, определяем по кадру: человек обычно в центре, по краям фон.
 * Возвращает null, если ни одна маска не отличается от пустой.
 */
export function pickPersonMask(masks: FloatMask[]): { data: Uint8ClampedArray; width: number; height: number } | null {
  let best: FloatMask | null = null;
  let bestScore = 0;
  for (const m of masks) {
    const { data, width: w, height: h } = m;
    let c = 0, cn = 0, b = 0, bn = 0;
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const v = data[y * w + x];
        if (x > w * 0.3 && x < w * 0.7 && y > h * 0.25 && y < h * 0.75) { c += v; cn++; }
        else if (x < w * 0.1 || x > w * 0.9) { b += v; bn++; }
      }
    }
    const score = (cn ? c / cn : 0) - (bn ? b / bn : 0);
    if (Math.abs(score) > Math.abs(bestScore)) { best = m; bestScore = score; }
  }
  if (!best || Math.abs(bestScore) < 0.05) return null;
  const out = new Uint8ClampedArray(best.width * best.height * 4);
  for (let i = 0; i < best.data.length; i++) {
    const v = bestScore < 0 ? 1 - best.data[i] : best.data[i];
    out[i * 4 + 3] = Math.round(v * 255);
  }
  return { data: out, width: best.width, height: best.height };
}
