import { assets } from '../../lib/assets/runtimeAssets';

/** A copy of an asset under a new id: the editor owns, and may delete, the assets of its own designs. Undefined when the asset is not in this browser. */
export async function copyAsset(assetId: string, newId: () => string): Promise<string | undefined> {
  const asset = await assets.getAsset(assetId);
  if (!asset) return undefined;
  const id = `template-copy-${newId()}`;
  await assets.putAsset(id, asset.blob);
  return id;
}
