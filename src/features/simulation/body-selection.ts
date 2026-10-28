export function updateBodySelection(
  selectedIds: readonly string[],
  primaryId: string,
  bodyId: string,
  additive: boolean,
): { selectedIds: string[]; primaryId: string; shouldFocusCamera: boolean } {
  if (!additive) return { selectedIds: [bodyId], primaryId: bodyId, shouldFocusCamera: true };
  let next = selectedIds.includes(bodyId)
    ? selectedIds.filter((id) => id !== bodyId)
    : [...selectedIds, bodyId];
  if (!next.length) next = [bodyId];
  return {
    selectedIds: next,
    primaryId: next.includes(primaryId) ? primaryId : next[0] ?? bodyId,
    shouldFocusCamera: false,
  };
}

export function isBodySelectionKeyboardShortcut(key: string, ctrlKey: boolean, metaKey: boolean): boolean {
  return key === " " && (ctrlKey || metaKey);
}
