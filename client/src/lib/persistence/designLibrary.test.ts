import { expect, it, vi } from 'vitest';
import { bootstrapEditor } from './bootstrap';
import { PROJECT_KEY } from './projectStorage';
import { DESIGNS_KEY } from './designLibrary';
import { assets } from '../assets/runtimeAssets';
import { createDocument } from '../../store/editorSlice';

const at = '2026-10-06T00:00:00.000Z';
function device() {
  const campaign = createDocument('campaign', at);
  campaign.name = 'My campaign';
  campaign.variants[0].background = { assetId: 'campaign-art', fit: 'cover', focalPoint: { x: .5, y: .5 } };
  const values = new Map([[PROJECT_KEY, JSON.stringify(campaign)]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: (key: string) => { values.delete(key); } };
  return { values, storage, campaign };
}
const result = (id: string, assetId: string) => {
  const document = createDocument(id, at);
  document.name = `mom and child · ${id}`;
  document.variants[0] = { ...document.variants[0], canvas: { width: 1216, height: 1520, backgroundColor: '#FFFFFF' }, background: { assetId, fit: 'cover', focalPoint: { x: .5, y: .5 } }, importedFrom: { templateId: 't', resultId: '4x5', runId: 'r' } };
  return document;
};

it('opening another design keeps the open one exactly, across a reload, and switching back restores it', () => {
  const { values, storage } = device();
  const session = bootstrapEditor(() => storage);
  session.openNewDesign(result('result-4x5', 'result-art'));
  expect(JSON.parse(values.get(PROJECT_KEY)!)).toMatchObject({ id: 'result-4x5' });
  expect(session.designs()).toEqual([{ id: 'campaign', name: 'My campaign', updatedAt: at, versions: 1 }]);
  // A reload opens the design that was open, and still lists the campaign.
  const reloaded = bootstrapEditor(() => storage);
  expect(reloaded.store.getState().editor.document.id).toBe('result-4x5');
  reloaded.openDesign('campaign');
  expect(reloaded.store.getState().editor.document).toMatchObject({ id: 'campaign', name: 'My campaign', variants: [{ background: { assetId: 'campaign-art' } }] });
  expect(reloaded.designs()).toEqual([{ id: 'result-4x5', name: 'mom and child · result-4x5', updatedAt: at, versions: 1, importedFrom: { templateId: 't', resultId: '4x5', runId: 'r' } }]);
  expect(values.has('frameflow:design:v1:campaign')).toBe(false);
});

it('"New design" discards only the open design, never pictures a stored design shows', async () => {
  const { storage } = device();
  const deleteAsset = vi.fn(async () => undefined), session = bootstrapEditor(() => storage, { ...assets, deleteAsset });
  // The result shares no picture with the campaign, except one it reuses: that one must stay.
  const shared = result('result-4x5', 'campaign-art');
  session.openNewDesign(shared);
  await session.newDesign();
  expect(deleteAsset).not.toHaveBeenCalledWith('campaign-art');
  expect(session.designs().map(d => d.id)).toEqual(['campaign']);
});

it('a damaged design index lists nothing and breaks nothing; an unreadable design cannot be opened', () => {
  const { values, storage } = device();
  values.set(DESIGNS_KEY, '{not json');
  const session = bootstrapEditor(() => storage);
  expect(session.designs()).toEqual([]);
  values.set(DESIGNS_KEY, JSON.stringify([{ id: 'gone', name: 'Gone', updatedAt: at, versions: 1 }]));
  expect(() => session.openDesign('gone')).toThrow('This design could not be read from this device.');
  expect(session.store.getState().editor.document.id).toBe('campaign');
});
