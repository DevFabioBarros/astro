import { expect, it } from "vitest";
import { isBodySelectionKeyboardShortcut, updateBodySelection } from "./body-selection";

it("toggles additive selection while keeping the primary when it remains selected", () => {
  expect(updateBodySelection(["sun", "earth"], "sun", "mars", true)).toEqual({ selectedIds: ["sun", "earth", "mars"], primaryId: "sun", shouldFocusCamera: false });
  expect(updateBodySelection(["sun", "earth"], "sun", "earth", true)).toEqual({ selectedIds: ["sun"], primaryId: "sun", shouldFocusCamera: false });
  expect(updateBodySelection(["earth"], "earth", "earth", true)).toEqual({ selectedIds: ["earth"], primaryId: "earth", shouldFocusCamera: false });
});

it("promotes the first remaining target only when removing the primary", () => {
  expect(updateBodySelection(["sun", "earth", "mars"], "earth", "earth", true)).toEqual({ selectedIds: ["sun", "mars"], primaryId: "sun", shouldFocusCamera: false });
  expect(updateBodySelection(["earth"], "earth", "mars", false)).toEqual({ selectedIds: ["mars"], primaryId: "mars", shouldFocusCamera: true });
});

it("provides Ctrl+Space or Command+Space as an additive-selection keyboard alternative", () => {
  expect(isBodySelectionKeyboardShortcut(" ", true, false)).toBe(true);
  expect(isBodySelectionKeyboardShortcut(" ", false, true)).toBe(true);
  expect(isBodySelectionKeyboardShortcut("Enter", true, false)).toBe(false);
});
