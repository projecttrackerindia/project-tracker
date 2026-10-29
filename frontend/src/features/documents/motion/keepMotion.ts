import type { Editor, JSONContent } from '@tiptap/core';

/** The motion blocks: atoms the AI never sees as text, so an AI edit must carry them across itself. */
export const EMBED_TYPES = ['motionLottie', 'motionSvg', 'motionVideo', 'sandboxEmbed'];

/**
 * Puts AI text in place of a range without losing what moves: motion blocks inside the range come back right after the new text (in their
 * order, exactly as they were), and the block the range starts in keeps its own motion (rise, fade…). The page's style is not in the editor's
 * text at all (it is kept with the stored body and only the Style panel changes it), so an edit can never drop it.
 */
export function replaceKeepingMotion(editor: Editor, range: { from: number; to: number }, content: JSONContent[] | JSONContent | string) {
  const { doc } = editor.state;
  const embeds: JSONContent[] = [];
  doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (EMBED_TYPES.includes(node.type.name)) { if (pos >= range.from && pos + node.nodeSize <= range.to) embeds.push(node.toJSON() as JSONContent); return false; }
    return true;
  });
  const $from = doc.resolve(Math.min(range.from, doc.content.size));
  const first = $from.depth >= 1 ? $from.node(1) : null;
  const motion = first && first.attrs.motion && first.attrs.motion !== 'none'
    ? { motion: first.attrs.motion as string, motionDelay: first.attrs.motionDelay as number, motionDuration: first.attrs.motionDuration as number } : null;

  editor.chain().focus().insertContentAt(range, content).run();

  if (embeds.length) {
    const $end = editor.state.doc.resolve(Math.min(editor.state.selection.to, editor.state.doc.content.size));
    editor.chain().insertContentAt($end.depth >= 1 ? $end.after(1) : $end.pos, embeds).run();
  }
  if (motion) {
    const $start = editor.state.doc.resolve(Math.min(range.from, editor.state.doc.content.size));
    if ($start.depth >= 1) {
      const pos = $start.before(1);
      const node = editor.state.doc.nodeAt(pos);
      if (node && 'motion' in node.attrs && (!node.attrs.motion || node.attrs.motion === 'none')) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...motion }));
    }
  }
}

/** Whether a stored body (editor JSON) holds something that moves: a motion block, a block with motion, or a picture (it may be a GIF). */
export function bodyMoves(json: string): boolean {
  return /"type":"(motionLottie|motionSvg|motionVideo|sandboxEmbed|docImage)"|"motion":"(fade|rise|scale|slide|stagger)"/.test(json);
}
