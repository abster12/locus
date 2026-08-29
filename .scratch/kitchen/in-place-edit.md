Status: closed

Parent: `.scratch/kitchen/spec.md` (Recipe Document, score, write API)

# In-place recipe score edit

The cooking score is the editor. Populated correction and a blank manual recipe are the same page. Prototype: `docs/kitchen-edit-prototype.html?variant=A`.

## Surface

- **Edit** and `#/kitchen/<item-id>/edit` make the existing recipe score writable. **Done** leaves edit mode and shows the last accepted score.
- No stacked form, no source/recipe split, no suggested-ingredient chips.
- Caption stays in **Source caption**. Select-to-place is out of this spec.
- This surface does not call a model. **Make this cookable** still creates the first draft when that path is used.

## Units

A unit is one of: **facts** (title, servings, total time), **one ingredient**, **one step**, **the composer**.

Working copy is what is on screen. Accepted copy is the last successful `POST /api/kitchen/items/:id/recipe`. Diff those two per unit.

- Edit in place. Clicking away does not write.
- Tick accepts that unit: merge it into the accepted draft, omit incomplete unaccepted rows, post the full draft with `status = draft`.
- Cross restores that unit from the accepted copy.
- First successful tick on a blank recipe creates the Recipe Document.
- **Save as reviewed** is a separate document-level action. A tick never reviews.
- Remove structure stays an overflow action.
- Failed write keeps the working copy.

User evidence on any typed or changed fact. Agent-proposed fields become user evidence when edited.

## Blank recipe

Same score, empty. Composer at the bottom of the spine is “what happens first?” then “what happens next?”.

- First keystroke shows **Draft**. Tick/cross appear on that beat immediately; do not wait for Enter.
- Composer tick creates the beat and writes it in one accept.
- Method may wrap; Enter on method/composer does not accept.

## Ingredients

- Single line. Qty, unit, name.
- **+ ingredient** on a beat: one click, cursor in the name field, custom fields visible.
- **Enter** on an ingredient field accepts that ingredient.
- Unplaced rows: **Place on** plus step numbers. One click hangs the ingredient on that beat. Tick the beat to write the placement.
- No pantry/suggestion chips under the method.

## Out of scope

Caption-span picking, per-field HTTP, calories as a stored field, variant B–E layouts.

## Done when

- Edit mode is the score, not `.kitchen-editor`.
- Blur does not persist; tick does; reload shows only accepted units.
- Enter accepts an ingredient; + ingredient focuses name; Place on N is one click.
- Blank recipe shows Draft on first keystroke; first tick creates the document.
- Existing module tests for `putRecipeDocument` still pass.
