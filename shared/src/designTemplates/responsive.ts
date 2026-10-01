import type { CanvasSize } from '../index.js';
import { DESIGN_ASPECT_RATIOS, type DesignAspectRatio, type DesignTemplate, type TemplateElement, type NormalizedLayout } from './schema.js';
import { setElementLayout } from './editing.js';
import { clampLayout } from './geometry.js';
export function ratioOfCanvas(canvas: CanvasSize): DesignAspectRatio {
  return DESIGN_ASPECT_RATIOS.reduce((best, ratio) => {
    const value = (r: string) => { const [w, h] = r.split(':').map(Number); return Math.abs(w / h - canvas.width / canvas.height); };
    return value(ratio) < value(best) ? ratio : best;
  });
}
/** Materialize a ratio before creative overrides/editor handoff so later resolution cannot overwrite a user's edits. */
export function elementAtRatio(element: TemplateElement, ratio: DesignAspectRatio): TemplateElement {
  if (!element.ratioLayouts) return element;
  const { ratioLayouts, ...rest } = element;
  return { ...rest, layout: ratioLayouts[ratio] ?? element.layout } as TemplateElement;
}
export function templateAtRatio(template: DesignTemplate, ratio: DesignAspectRatio): DesignTemplate {
  return { ...template, elements: template.elements.map(element => elementAtRatio(element, ratio)) };
}
export function setRatioLayout(template: DesignTemplate, id: string, ratio: DesignAspectRatio, values: Partial<NormalizedLayout>): DesignTemplate {
  const current = template.elements.find(element => element.id === id);
  if (!current?.ratioLayouts || current.type === 'background') return setElementLayout(template, id, values);
  const previous = elementAtRatio(current, ratio).layout;
  const layout = clampLayout({ ...previous, ...values });
  if ((Object.keys(layout) as (keyof NormalizedLayout)[]).every(key => layout[key] === previous[key])) return template;
  return { ...template, elements: template.elements.map(element => element !== current ? element : {
    ...current, ratioLayouts: { ...current.ratioLayouts, [ratio]: layout },
  }) };
}
