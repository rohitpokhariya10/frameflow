import { describe, expect, it } from 'vitest';
import { shapeFillProps } from './layerGeometry';

const shape = { fill: '#ff0000', width: 200, height: 100, gradient: { from: '#ff0000', to: '#0000ff', angle: 0 } };

describe('shape gradient coordinates', () => {
  it('spans an ellipse from its left edge to its right edge around the local center', () => {
    expect(shapeFillProps(shape, 'center')).toEqual({
      fillLinearGradientStartPoint: { x: -100, y: 0 }, fillLinearGradientEndPoint: { x: 100, y: 0 },
      fillLinearGradientColorStops: [0, '#ff0000', 1, '#0000ff'],
    });
    expect(shapeFillProps(shape)).toMatchObject({ fillLinearGradientStartPoint: { x: 0, y: 50 }, fillLinearGradientEndPoint: { x: 200, y: 50 } });
  });

  it.each([90, -90])('spans the full ellipse height at %s degrees', angle => {
    const fill = shapeFillProps({ ...shape, gradient: { ...shape.gradient, angle } }, 'center');
    expect(fill.fillLinearGradientStartPoint!.x).toBeCloseTo(0);
    expect(fill.fillLinearGradientEndPoint!.x).toBeCloseTo(0);
    expect(fill.fillLinearGradientStartPoint!.y).toBeCloseTo(angle === 90 ? -50 : 50);
    expect(fill.fillLinearGradientEndPoint!.y).toBeCloseTo(angle === 90 ? 50 : -50);
  });

  it('aligns a diagonal canvas/export ellipse gradient with the top-left SVG thumbnail after translation', () => {
    const diagonal = { ...shape, gradient: { ...shape.gradient, angle: 45 } };
    const ellipse = shapeFillProps(diagonal, 'center'), thumbnail = shapeFillProps(diagonal);
    expect(ellipse.fillLinearGradientStartPoint!.x).toBeCloseTo(-75);
    expect(ellipse.fillLinearGradientStartPoint!.y).toBeCloseTo(-75);
    expect(ellipse.fillLinearGradientEndPoint!.x).toBeCloseTo(75);
    expect(ellipse.fillLinearGradientEndPoint!.y).toBeCloseTo(75);
    for (const key of ['fillLinearGradientStartPoint', 'fillLinearGradientEndPoint'] as const) {
      expect(ellipse[key]!.x + 100).toBeCloseTo(thumbnail[key]!.x);
      expect(ellipse[key]!.y + 50).toBeCloseTo(thumbnail[key]!.y);
    }
  });

  it('keeps solid colours unchanged for both coordinate origins', () => {
    expect(shapeFillProps({ ...shape, gradient: undefined }, 'center')).toEqual({ fill: '#ff0000' });
    expect(shapeFillProps({ ...shape, gradient: undefined })).toEqual({ fill: '#ff0000' });
  });
});
