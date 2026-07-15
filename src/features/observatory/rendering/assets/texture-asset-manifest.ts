import { z } from 'zod';

import manifestJson from './planetary-assets.json';

const sha256Schema = z.string().regex(/^[A-F0-9]{64}$/);
const textureAssetRoleSchema = z.enum(['surface-color', 'ring-opacity', 'cloud-opacity']);
const textureAssetDescriptorSchema = z.object({
  bodyId: z.string().min(1),
  bytes: z.number().int().positive(),
  file: z.string().min(1),
  height: z.number().int().positive(),
  id: z.string().min(1),
  role: textureAssetRoleSchema,
  sha256: sha256Schema,
  sourceBytes: z.number().int().positive(),
  sourceSha256: sha256Schema,
  sourceUrl: z.url(),
  url: z.string().startsWith('/assets/planetary/'),
  width: z.number().int().positive(),
});
const textureAssetManifestSchema = z
  .object({
    assets: z.array(textureAssetDescriptorSchema).min(1),
    license: z.object({
      id: z.literal('CC-BY-4.0'),
      name: z.string().min(1),
      url: z.url(),
    }),
    processing: z.object({
      cloud: z.string().min(1),
      ring: z.string().min(1),
      surface: z.string().min(1),
      tool: z.string().min(1),
      version: z.string().min(1),
    }),
    publisher: z.string().min(1),
    schemaVersion: z.literal(1),
    sourceNotes: z.string().min(1),
    sourcePageUrl: z.url(),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const files = new Set<string>();
    for (const [index, asset] of manifest.assets.entries()) {
      if (ids.has(asset.id)) {
        context.addIssue({
          code: 'custom',
          message: `重复资产 ID: ${asset.id}`,
          path: ['assets', index, 'id'],
        });
      }
      if (files.has(asset.file)) {
        context.addIssue({
          code: 'custom',
          message: `重复资产文件: ${asset.file}`,
          path: ['assets', index, 'file'],
        });
      }
      ids.add(asset.id);
      files.add(asset.file);
    }
  });

export type TextureAssetRole = z.infer<typeof textureAssetRoleSchema>;
export type TextureAssetDescriptor = z.infer<typeof textureAssetDescriptorSchema>;
export type TextureAssetManifest = z.infer<typeof textureAssetManifestSchema>;

export const PLANETARY_TEXTURE_ASSET_MANIFEST: TextureAssetManifest =
  textureAssetManifestSchema.parse(manifestJson);

const assetsById = new Map(
  PLANETARY_TEXTURE_ASSET_MANIFEST.assets.map((asset) => [asset.id, asset]),
);

export function getTextureAssetDescriptor(assetId: string): TextureAssetDescriptor {
  const descriptor = assetsById.get(assetId);
  if (descriptor === undefined) {
    throw new Error(`未知纹理资产: ${assetId}`);
  }
  return descriptor;
}
