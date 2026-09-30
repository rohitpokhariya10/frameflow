import { CANVAS_PRESETS, paintOrder, validateCanvasSize, type CanvasSize, type DesignVariant } from '@frameflow/shared';
import { Group } from 'konva/lib/Group';
import { Rect } from 'konva/lib/shapes/Rect';
import { Image as KonvaImage } from 'konva/lib/shapes/Image';
import { Text } from 'konva/lib/shapes/Text';
import { Ellipse } from 'konva/lib/shapes/Ellipse';
import { Circle } from 'konva/lib/shapes/Circle';
import { cornerRadius, layerImageProps, shapeFillProps, strokeProps } from '../canvas/layerGeometry';
import { assets, abortable, decodeImage } from '../../lib/assets/runtimeAssets';
import { imagePlacement } from '../canvas/BackgroundArtwork';
import { loadEditorFonts } from '../text/fonts';
import { textDisplay } from '../text/textGeometry';

export function exportFilename(canvas: CanvasSize) {
  const format = CANVAS_PRESETS.find((preset) => preset.width === canvas.width && preset.height === canvas.height)?.id ?? 'custom';
  return `frameflow-${format}-${canvas.width}x${canvas.height}.png`;
}

/** A clean Konva group uses the editor's node styles in logical pixels. No Stage,
 * display zoom, hit canvas, Transformer, or document action is needed. */
export async function exportPng(variant: DesignVariant): Promise<Blob> {
  const { canvas, background, layers = [] } = variant;
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
      // An empty image slot has nothing to draw.
      const assetId = layer.type === 'image' && layer.visible ? layer.assetId : undefined;
      if (!assetId || bitmaps.has(assetId)) continue;
      try {
        const asset = await abortable(assets.getAsset(assetId), controller.signal);
        if (!asset) throw new Error('Missing layer');
        bitmaps.set(assetId, await decodeImage(asset.blob, controller.signal));
      } catch { throw new Error(`Layer "${layer.name}" could not load for export. Delete or replace it, then retry.`); }
    }
    group = new Group({ listening: false });
    // A transparent canvas exports with real alpha: nothing is painted behind the layers.
    if (!canvas.transparent) group.add(new Rect({ width: canvas.width, height: canvas.height, fill: canvas.backgroundColor }));
    if (image && background) group.add(new KonvaImage({ image, ...imagePlacement(
      { width: image.naturalWidth, height: image.naturalHeight }, canvas, background.fit, background.focalPoint,
    ) }));
    // Back to front in the one order the editor draws in: layers then text, or by zIndex where the design carries one.
    for (const item of paintOrder(variant)) {
      if (item.kind === 'text') {
        const element = item.element, display = textDisplay(element);
        if (element.visible === false) continue;
        if (display.box) group.add(new Rect({ x: element.x, y: element.y, rotation: display.rotation, ...display.box }));
        group.add(new Text({ ...display.props, x: element.x, y: element.y, rotation: display.rotation, offsetY: display.offsetY }));
        continue;
      }
      const layer = item.layer;
      if (!layer.visible) continue;
      const node = new Group({ x: layer.x, y: layer.y, rotation: layer.rotation, opacity: layer.opacity });
      if (layer.type === 'image') {
        const bitmap = layer.assetId ? bitmaps.get(layer.assetId) : undefined;
        if (!bitmap) continue;
        node.add(new KonvaImage({ image: bitmap, ...layerImageProps(layer, bitmap) }));
      } else if (layer.shapeType === 'circle') {
        const side = Math.min(layer.width, layer.height);
        node.add(new Circle({ x: layer.width / 2, y: layer.height / 2, radius: side / 2, ...shapeFillProps({ ...layer, width: side, height: side }, 'center'), ...strokeProps(layer) }));
      } else if (layer.shapeType === 'ellipse') node.add(new Ellipse({ x: layer.width / 2, y: layer.height / 2, radiusX: layer.width / 2, radiusY: layer.height / 2, ...shapeFillProps(layer, 'center'), ...strokeProps(layer) }));
      else node.add(new Rect({ width: layer.width, height: layer.height, cornerRadius: cornerRadius(layer), ...shapeFillProps(layer), ...strokeProps(layer) }));
      group.add(node);
    }
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
