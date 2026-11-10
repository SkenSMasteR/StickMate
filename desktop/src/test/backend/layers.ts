import type { MockExtension } from "../backend";

export const handlers: MockExtension = (context) => ({
  doc_duplicate_layer: (args) =>
    context.edit(args.id as string, (doc) => {
      const target = context.scene(doc, args.sceneId as string);
      context.duplicateLayerTree(target.layers, args.layerId as string);
      context.validateSceneMasks(target);
    })
});
