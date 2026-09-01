# Build the unified Add Stop and empty-state flow

Type: task
Status: resolved
Blocked by: 25

## Outcome

Every Trip Day and Unscheduled area uses one focused Add Stop flow, and both a new empty Trip Document and an empty focused day provide a useful next action without starting inference.

## Problem

The current planner repeats Add from Library, Add a placeholder, and Add a hole controls in day headers and empty states. The forms render inline, use inconsistent fields, and cannot deliberately save a human Draft. The approved Direction A consolidates these paths into one dialog and gives the two empty states distinct, restrained guidance.

## Scope

- `app/src/trips-day-section.tsx`
- `app/src/trips-stops.tsx`
- `app/src/trips-stop-forms.tsx`
- `app/src/trips-library-picker.tsx`
- `app/src/trips-stop-ops.ts`
- Focused client tests and Trips browser schedule/library/responsive suites

## Implementation

1. Replace the three repeated day-header buttons with one primary **Add stop** action.
2. Model the open flow explicitly: target day or Unscheduled, source choice, optional hole-fill placement, and active form.
3. Render an accessible modal dialog with three source choices:
   - Choose from Library;
   - Add outside content;
   - Add a hole.
4. Keep Library references authoritative and outside content trip-owned. Reuse the current bounded search, URL sanitization, and stable-id insertion path.
5. Give Library and outside-content forms explicit placement, time, duration, and notes fields as supported by the Trip Stop model. Extend the client `addStop` contract and shared builder to carry `publicNotes` and `privateNotes`; the server operation already accepts them.
6. Keep outside-content source notes inside `content.notes`, public shareable notes in `publicNotes`, and Library-private context in `privateNotes`. Label these destinations directly in the forms.
7. Submit through one operation builder. **Add stop** omits state; **Save as Draft** requests Draft. Disable both while saving and keep the dialog open with an error when mutation fails.
8. Give hole creation its bounded request and placement flow without a Draft choice.
9. Implement the approved empty states:
   - new Trip Document: **Add first stop** plus concise optional next steps;
   - empty focused day: **Add stop**, **Ask agent for options**, and relevant Unscheduled entries.
10. Opening a dialog or empty state performs no inference or write. Preserve the existing honest no-agent behavior for Ask agent for options.
11. Restore focus to the invoking control on close; support Escape, labelled headings, error announcements, and 16px mobile controls.

## Tests

- Each day and Unscheduled exposes one Add Stop entry point rather than three repeated controls.
- All three source choices reach the correct form and placement.
- Library and outside-content paths can add Confirmed or save Draft in one POST.
- Public notes, private notes, and outside-content source notes round-trip into their distinct fields; Share Snapshot projection continues to expose only public notes.
- Hole fill remains one atomic remove-plus-add changeset at the original placement.
- Dialog cancellation and source switching write nothing and preserve understandable focus.
- New-trip and empty-day states make no agent or mutation request on open.
- Empty-day actions and dialogs fit at 1440px, tablet, and 320px without document overflow.

## Completion criteria

- The complete add flow matches the approved Direction A hierarchy and uses production Locus components/tokens.
- No add path duplicates insertion or state policy.
- Focused tests, `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

- Drag reordering.
- Stop-details redesign.
- Automatic agent invocation or generated suggestions.

## Answer

One **Add stop** control per day and Unscheduled opens a native modal: Library, outside content, or hole. Library and outside submit through `buildAddOrFillOps` with **Add stop** (omit state) or **Save as Draft**; holes have no Draft choice. Notes land in `content.notes` / `publicNotes` / `privateNotes`. Empty trip Overview leads with **Add first stop**; empty focused day leads with **Add stop** and **Ask agent for options**. Opening either writes nothing. Focused client tests, typecheck, build, and `npm test` pass.
