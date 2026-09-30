/** The review image is contained; pointer positions in letterboxed space are rejected. */
export function nativePointer(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  const scale = Math.min(rect.width / width, rect.height / height);
  const left = rect.left + (rect.width - width * scale) / 2;
  const top = rect.top + (rect.height - height * scale) / 2;
  const x = (clientX - left) / scale, y = (clientY - top) / scale;
  return x >= 0 && y >= 0 && x < width && y < height ? { x, y } : null;
}
