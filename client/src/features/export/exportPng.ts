import { CANVAS_PRESETS, validateCanvasSize, type CanvasSize, type DesignVariant } from '@frameflow/shared';
import { Group } from 'konva/lib/Group';
import { Rect } from 'konva/lib/shapes/Rect';
import { Image as KonvaImage } from 'konva/lib/shapes/Image';
import { Text } from 'konva/lib/shapes/Text';
import { Ellipse } from 'konva/lib/shapes/Ellipse';
import { cornerRadius, shapeFillProps, strokeProps } from '../canvas/layerGeometry';
import { assets, abortable, decodeImage } from '../../lib/assets/runtimeAssets';
import { imagePlacement } from '../canvas/BackgroundArtwork';
import { loadEditorFonts } from '../text/fonts';
import { textNodeStyle } from '../text/textGeometry';

export function exportFilename(canvas: CanvasSize) {
  const format = CANVAS_PRESETS.find((preset) => preset.width === canvas.width && preset.height === canvas.height)?.id ?? 'custom';
  return `frameflow-${format}-${canvas.width}x${canvas.height}.png`;
}

/** A clean Konva group uses the editor's node styles in logical pixels. No Stage,
 * display zoom, hit canvas, Transformer, or document action is needed. */
export async function exportPng(variant: DesignVariant): Promise<Blob> {
  const { canvas, background, elements, layers = [] } = variant;
  if (!validateCanvasSize(canvas.width, canvas.height).valid) throw new Error('This canvas size cannot be exported. Choose a valid size and retry.');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new Error('Export took too long. Reload the editor and try again.')), 30_000);
  let group: Group | undefined, output: HTMLCanvasElement | undefined;
  try {
    try { await abortable(loadEditorFonts(), controller.signal); }
    catch { throw new Error('Fonts could not load for export. Check your connection and retry.'); }
    let image: HTMLImageElement | undefined;
    if (background) {
      try {
        const asset = await abortable(assets.getAsset(background.assetId), controller.signal);
        if (!asset) throw new Error('Missing artwork');
        image = await decodeImage(asset.blob, controller.signal);
      } catch { throw new Error('Artwork could not load for export. Reload the editor or replace the missing artwork, then retry.'); }
    }
    // Layer bitmaps load before drawing; a missing layer image fails the export rather than silently dropping it.
    const bitmaps = new Map<string, HTMLImageElement>();
    for (const layer of layers) {
      if (layer.type !== 'image' || !layer.visible || bitmaps.has(layer.assetId)) continue;
      try {
        const asset = await abortable(assets.getAsset(layer.assetId), controller.signal);
        if (!asset) throw new Error('Missing layer');
        bitmaps.set(layer.assetId, await decodeImage(asset.blob, controller.signal));
      } catch { throw new Error(`Layer "${layer.name}" could not load for export. Delete or replace it, then retry.`); }
    }
    group = new Group({ listening: false });
    group.add(new Rect({ width: canvas.width, height: canvas.height, fill: canvas.backgroundColor }));
    if (image && background) group.add(new KonvaImage({ image, ...imagePlacement(
      { width: image.naturalWidth, height: image.naturalHeight }, canvas, background.fit, background.focalPoint,
    ) }));
    for (const layer of layers) {
      if (!layer.visible) continue;
      const node = new Group({ x: layer.x, y: layer.y, rotation: layer.rotation, opacity: layer.opacity });
      if (layer.type === 'image') node.add(new KonvaImage({ image: bitmaps.get(layer.assetId)!, width: layer.width, height: layer.height }));
      else if (layer.shapeType === 'ellipse') node.add(new Ellipse({ x: layer.width / 2, y: layer.height / 2, radiusX: layer.width / 2, radiusY: layer.height / 2, ...shapeFillProps(layer), ...strokeProps(layer) }));
      else node.add(new Rect({ width: layer.width, height: layer.height, cornerRadius: cornerRadius(layer), ...shapeFillProps(layer), ...strokeProps(layer) }));
      group.add(node);
    }
    for (const element of elements) group.add(new Text({ ...textNodeStyle(element), x: element.x, y: element.y }));
    try {
      output = group.toCanvas({ x: 0, y: 0, width: canvas.width, height: canvas.height, pixelRatio: 1 });
      const blob = await abortable(new Promise<Blob>((resolve, reject) => {
        output!.toBlob((value) => value?.size && value.type === 'image/png' ? resolve(value) : reject(new Error('Empty PNG')), 'image/png');
      }), controller.signal);
      return blob;
    } catch { throw new Error('Could not create the PNG. Close other browser tabs to free memory and retry.'); }
  } finally {
    window.clearTimeout(timer);
    group?.destroy();
    if (output) { output.width = 0; output.height = 0; }
  }
}

/** Allow the browser time to consume the download URL before releasing it. */
export function downloadPng(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  try {
    anchor.href = url; anchor.download = filename;
    document.body.append(anchor); anchor.click();
  } catch {
    throw new Error('Could not start the download. Allow downloads for this site and retry.');
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
