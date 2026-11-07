import type { MockExtension } from "../backend";

export const handlers: MockExtension = (context) => ({
  doc_duplicate_layer: (args) =>
    context.edit(args.id as string, (doc) => {
      const target = context.scene(doc, args.sceneId as string);
      const index = target.layers.indexOf(
        context.layer(doc, args.sceneId as string, args.layerId as string)
      );
      const copy = structuredClone(target.layers[index]);
      copy.id = context.id("l");
      copy.name = `${copy.name} copy`;
      target.layers.splice(index + 1, 0, copy);
    })
});