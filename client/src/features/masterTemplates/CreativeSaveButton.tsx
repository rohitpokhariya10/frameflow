/**
 * In the editor, for a version opened from a master template's creative: saves the version's texts, pictures and shapes
 * back to that creative (a new creative revision; the master is never changed). Pictures replaced or added in the editor
 * are uploaded to the creative first. Shows whether the version matches the saved creative.
 */
import { useState } from 'react';
import { CloudUpload } from 'lucide-react';
import { isOfferFont } from '@frameflow/shared';
import { selectActiveVariant, useAppDispatch, useAppSelector } from '../../store';
import { creativeSynced } from '../../store/editorSlice';
import { assets } from '../../lib/assets/runtimeAssets';
import { masterApi } from './api';
import { creativeFromEditor, isCreativeVariant } from './creativeDocument';
import { saveProductVariant } from '../productTemplates/productEditor';
import { productApi } from '../productTemplates/api';

/** Pictures already uploaded in this session (editor asset id → creative asset), so a second save does not send them again. */
const uploaded = new Map<string, { asset: Awaited<ReturnType<typeof masterApi.uploadAsset>>['asset'] }>();

export async function saveVariantToCreative(variant: Parameters<typeof creativeFromEditor>[0], designId: string) {
  if (!isCreativeVariant(variant)) throw new Error('This version is not a creative of a master template.');
  if (variant.creative.product) return saveProductVariant(variant);
  const link = variant.creative, current = await masterApi.getCreative(link.masterId, link.creativeId);
  if (current.revision !== link.syncedRevision) throw new Error(`The creative was changed elsewhere (revision ${current.revision}; this version was made from revision ${link.syncedRevision}). Reopen it from Offer Templates to continue from the saved creative.`);
  const { creative, uploads, problems } = creativeFromEditor(variant, current, isOfferFont);
  if (problems.length) throw new Error(problems.join(' '));
  for (const u of uploads) {
    let done = uploaded.get(u.assetId);
    if (!done) {
      const stored = await assets.getAsset(u.assetId);
      if (!stored) throw new Error(`The picture of "${u.name}" is missing from this browser; replace it again.`);
      done = { asset: (await masterApi.uploadAsset(current, stored.blob, u.name)).asset };
      uploaded.set(u.assetId, done);
    }
    const image = creative.images.find(i => i.id === u.imageId);
    if (image) image.asset = done.asset;
  }
  return masterApi.saveCreative(creative, 'editor', designId);
}

export function CreativeSaveButton() {
  const variant = useAppSelector(selectActiveVariant), designId = useAppSelector(state => state.editor.document.id), dispatch = useAppDispatch();
  const [state, setState] = useState<{ busy: boolean; message: string; error: boolean }>({ busy: false, message: '', error: false });
  if (!isCreativeVariant(variant)) return null;
  const save = async (master = false) => {
    setState({ busy: true, message: '', error: false });
    let savedRevision: number | undefined;
    try {
      const saved = await saveVariantToCreative(variant, designId);
      savedRevision = saved.revision;
      dispatch(creativeSynced({ variantId: variant.id, syncedRevision: saved.revision }));
      if (master && variant.creative.product && variant.creative.masterEditing) {
        const v = await productApi.saveEditorMaster(variant.creative.masterId, variant.creative.creativeId, saved.revision, variant.creative.masterRevision);
        const revision = v.product.revisions.at(-1)!.revision;
        dispatch(creativeSynced({ variantId: variant.id, syncedRevision: saved.revision, masterRevision: revision }));
        setState({ busy: false, message: `Saved master draft · revision ${revision}. Quality review retained.`, error: false });
        return;
      }
      setState({ busy: false, message: `Saved to creative · revision ${saved.revision}`, error: false });
    } catch (e) { setState({ busy: false, message: `${master && savedRevision ? `Creative revision ${savedRevision} was saved, but the master was not changed. ` : ''}${e instanceof Error ? e.message : 'Could not save the creative.'}`, error: true }); }
  };
  return <div className="creative-save">
    <button className="button" disabled={state.busy} aria-busy={state.busy} title="Save this version's text, objects, logos and shapes as a creative revision." onClick={() => void save()}>
      <CloudUpload size={15} aria-hidden="true" />{state.busy ? 'Saving…' : 'Save creative'}
    </button>
    {variant.creative.product && variant.creative.masterEditing && <button className="button" disabled={state.busy} onClick={() => void save(true)}>Save Master Template</button>}
    {state.message && <span className={state.error ? 'creative-save-error' : 'creative-save-ok'} role={state.error ? 'alert' : 'status'}>{state.message}</span>}
  </div>;
}
