Status: ready-for-agent

# Atlas — trustworthy places for saved Items

## Problem Statement

Atlas currently looks like a place-aware view, but it has no durable understanding of places. It selects Items through the `travel` topic tag and scans each Item's title and body at render time against a small source-code list of place names and five hand-written regions. Every matched word is treated as equally meaningful.

This causes several user-visible failures:

- Travel Items whose location is not in the source-code list collect in a quiet **Unplaced** disclosure at the bottom, without a useful way to resolve them.
- Obvious places such as Italy, Amsterdam, Qingdao, the Dolomites, and a misspelled Dharamshala are not recognized unless a developer edits the application.
- A Philippines Reel can also appear under India because its caption addresses Indian travelers or mentions Mumbai as an origin. Atlas cannot distinguish a destination from an audience, origin, comparison, author identity, or incidental mention.
- One Item can be rendered in several regions and counted several times even when it has only one real destination.
- The broad region called “Southeast Asia & beyond” mixes the Philippines and Vietnam with Portugal, New York, London, Paris, Dubai, Nepal, Europe, and the USA.
- There is no saved correction. The next render repeats the same text match, so a human cannot make Atlas learn that a particular Item belongs somewhere else.
- Atlas only admits Items carrying the `travel` topic tag. A restaurant, café, shop, venue, or nearby activity saved for the user's own city can remain absent when it is tagged Food or another topic.
- There is no home base, so Atlas cannot distinguish places the user wants to visit around home from destinations for a trip.
- Geography is application configuration rather than Library data. Supporting a new city, country, spelling, language, or venue requires a code change.

The evidence in the current local Library makes the defect concrete. On 2026-08-29 there were 44 Items carrying the Travel tag. Ten had no match in the current place list. Two were rendered across more than one country group because destination and incidental geographic language were treated alike. These figures motivate the design; they are not acceptance-test constants.

The user needs Atlas to organize saved places reliably, offer a small set of useful choices when it is unsure, accept an exact human override, remember corrections, and recognize home-city saves without any compiled list of supported locations.

## Solution

Atlas becomes a durable Library projection backed by a general **Place** and **Place Assignment** model.

Every Item may be analyzed for whether it represents somewhere the user could visit. Analysis is independent of topic tags: Travel, Food, Art, or any other tag may be useful context, but no tag is required for a resolved Item to appear in Atlas. This lets a Bengaluru restaurant appear in both Kitchen and Atlas without turning either view into an exclusive folder.

Location analysis is a background enrichment process, not React rendering logic. A configured analyzer interprets the captured title and body and proposes structured destination candidates with exact source evidence. It distinguishes a primary destination from contained places and incidental mentions. Its output is untrusted and validated by Locus; it is never allowed to overwrite a human decision.

Atlas has four user-facing classification outcomes:

1. **Placed** — the Item has one primary destination and appears once under that destination.
2. **Needs a place** — the Item is Atlas-relevant but its destination is absent, ambiguous, or insufficiently supported.
3. **Multiple destinations** — the Item genuinely covers several peer destinations and appears once in a dedicated group.
4. **Not for Atlas** — the Item mentions geography but is not a saved place or useful travel reference.

The Atlas page leads with a **Needs a place** Alert: a count and a small preview, with Review revealing the rows. Each row shows up to three proposed destinations, the evidence for each, and actions to choose an exact place, mark it as multiple destinations, mark it Not for Atlas, or leave it unresolved. This review area is prominent enough to act on and is not buried beneath the destination sections. Page widgets are locked in **Atlas UI kit**.

Every placed Item has a quiet **Change place** action. A user selection becomes authoritative and survives recapture, reanalysis, application restart, export, and import. Automatic results remain visibly inferred until the user confirms or changes them.

The user chooses one **home base**, initially expected to be Bengaluru but never encoded as a default in source code. Items assigned to the home Place or one of its contained Places appear under **Around &lt;home base&gt;**. Other Items are grouped through their stored Place hierarchy, such as country and city. An Item may retain contained places such as Kyoto and Osaka while appearing only once under its primary destination, Japan. A genuine multi-country roundup appears only once under Multiple destinations.

There is no hard-coded location or region taxonomy. Places are created from analyzer suggestions and human input and stored in the Library. The current place matcher, current place list, and current five-region presentation taxonomy are removed rather than extended. A new place, spelling, language, or user-created venue must work without a source-code change.

When configured analysis is unavailable, Atlas degrades honestly. Existing confirmed assignments still render, unresolved Travel Items remain reviewable, and the user can choose or create an exact Place manually. Locus does not fall back to a hidden word list.

## User Stories

1. As a Locus user, I want Atlas to remember where an Item belongs, so that its location does not change every time the page renders.
2. As a Locus user, I want a Philippines travel Reel to appear under the Philippines, so that references to Indian travelers do not misfile it under India.
3. As a Locus user, I want “flights from Mumbai” treated as an origin rather than a destination, so that Atlas reflects where the trip goes.
4. As a Locus user, I want comparisons such as “cheaper than Bali” treated as incidental when Bali is not the subject, so that comparison places do not duplicate the Item.
5. As a Locus user, I want author identity such as “I’m Japanese” distinguished from a destination, so that author context does not become a trip.
6. As a Locus user, I want a product recommendation containing “USA” excluded from Atlas when it is not a place save, so that geographic words alone do not create destinations.
7. As a Locus user, I want a genuine Philippines guide containing several islands to appear once, so that one guide is not copied across the page.
8. As a Locus user, I want contained cities and landmarks retained on an Item, so that a country-level guide does not lose useful detail.
9. As a Locus user, I want a genuine multi-country roundup shown once under Multiple destinations, so that Atlas represents its scope without duplicating it.
10. As a Locus user, I want destination counts to count distinct Items, so that one caption with several place words does not inflate the totals.
11. As a Locus user, I want Atlas to support any city or country, so that I do not wait for a developer to add it.
12. As a Locus user, I want Atlas to support neighbourhoods, venues, landmarks, and natural areas, so that local saves are not limited to country-level travel.
13. As a Locus user, I want alternate spellings such as Bangalore and Bengaluru to resolve coherently, so that one city is not fragmented into arbitrary sections.
14. As a Locus user, I want likely misspellings such as Dhramshala to produce a Dharamshala suggestion, so that imperfect captured text is still usable.
15. As a Locus user, I want non-English and accented place names accepted, so that Atlas is not restricted to an English source-code vocabulary.
16. As a Locus user, I want a custom Place when no suggestion is correct, so that small venues and unusual destinations are still representable.
17. As a Locus user, I want a custom Place to have an optional parent, so that I can put a venue inside the right city.
18. As a Locus user, I want places created from data rather than code, so that my Library can grow without product releases.
19. As a Locus user, I want the current hard-coded regions removed, so that Portugal is not grouped under Southeast Asia & beyond.
20. As a Locus user, I want destinations grouped by their stored hierarchy, so that country and city sections make geographic sense.
21. As a Locus user, I want Atlas to show an Item with a resolved Place even when it is not tagged Travel, so that local Food and activity saves are included.
22. As a Locus user, I want a Food Item to remain a Food Item when it appears in Atlas, so that place organization does not rewrite topic organization.
23. As a Locus user, I want the same Item available in Kitchen and Atlas when both views are useful, so that projections are not exclusive folders.
24. As a Locus user, I want unresolved Travel Items retained in Atlas’s review queue, so that removing the word matcher does not make them disappear.
25. As a Locus user, I want a wrongly Travel-tagged Item to offer Not for Atlas, so that I can remove Atlas noise directly where I see it.
26. As a Locus user, I want Not for Atlas to remain effective after reanalysis, so that the same false positive does not return.
27. As a Locus user, I want Atlas relevance decided separately from geographic extraction, so that mentioning a place is not enough to enter Atlas.
28. As a Locus user, I want every Item eligible for background analysis, so that useful local saves are not gated by a small topic-tag allowlist.
29. As a Locus user, I want analysis to happen away from page rendering, so that opening Atlas does not repeatedly send captions to a provider.
30. As a Locus user, I want analysis progress to survive a restart, so that a partial backfill can continue rather than begin again.
31. As a Locus user, I want a failed analysis attempt to be retryable, so that a temporary provider failure does not permanently strand an Item.
32. As a Locus user, I want an Item with no usable captured text to remain unresolved, so that Locus does not pretend it inspected inaccessible video.
33. As a Locus user, I want automatic analysis to cite the captured words supporting a destination, so that I can judge a suggestion quickly.
34. As a Locus user, I want at most three destination suggestions at once, so that resolving an Item is a small choice rather than a search-results page.
35. As a Locus user, I want suggestions ordered by usefulness, so that the likely destination is easiest to select.
36. As a Locus user, I want unsupported analyzer claims rejected, so that an invented destination cannot silently become Library truth.
37. As a Locus user, I want uncertain analysis to enter Needs a place, so that ambiguity is visible instead of guessed away.
38. As a Locus user, I want one clear inferred destination placed automatically, so that Atlas does not require reviewing every obvious Item.
39. As a Locus user, I want inferred placement identified quietly, so that I can distinguish it from my decisions without filling the page with warnings.
40. As a Locus user, I want every inferred card to offer Change place, so that a confident but wrong result is easy to correct.
41. As a Locus user, I want my selected destination to outrank the analyzer, so that Atlas learns from me rather than arguing with me.
42. As a Locus user, I want reanalysis after captured text changes without losing my confirmed Place, so that new source material cannot erase my correction.
43. As a Locus user, I want the application to tell me when source text changed behind a confirmed assignment only when that fact is useful, so that durable corrections remain calm rather than stale-looking.
44. As a Locus user, I want Needs a place near the top of Atlas, so that unresolved Items do not collect unnoticed at the bottom.
45. As a Locus user, I want Needs a place summarized by a count and small preview, so that it remains quiet when I am browsing destinations.
46. As a Locus user, I want to expand the complete review list, so that I can clean up several Items in one session.
47. As a Locus user, I want each review row to show enough title, media, creator, and caption evidence to recognize the Item, so that choices are not anonymous.
48. As a Locus user, I want to select one of the proposed Places with one action, so that obvious corrections are fast.
49. As a Locus user, I want Choose exact place when none of the suggestions is right, so that the analyzer never limits my choices.
50. As a Locus user, I want exact-place selection to search Places already known to my Library, so that I can reuse an existing city or venue consistently.
51. As a Locus user, I want to create the exact Place I typed when it is not already known, so that manual resolution works offline and without a provider.
52. As a Locus user, I want to mark an Item as Multiple destinations, so that roundups are not forced into one country.
53. As a Locus user, I want to leave an Item unresolved, so that I am not forced to guess merely to dismiss the review row.
54. As a Locus user, I want a resolved review row to move immediately into its destination section, so that I can see the effect of my decision.
55. As a Locus user, I want changing a placed Item to update its section and counts immediately, so that Atlas never shows the old and new placement together.
56. As a Locus user, I want one home base, so that saves around the city where I live have a natural home.
57. As a Locus user, I want to choose Bengaluru as my home base rather than have it compiled into the application, so that the same product works for another person or after I move.
58. As a Locus user, I want to change my home base without retagging Items, so that home is a projection over Places rather than copied classification data.
59. As a Locus user, I want Items assigned to my home Place or its contained Places under Around Bengaluru, so that places I want to visit locally are easy to browse.
60. As a Locus user, I want no guessed distance radius when coordinates are absent, so that “around home” does not make unsupported proximity claims.
61. As a Locus user, I want a clear invitation to choose a home base when none exists, so that the local section is understandable rather than silently missing.
62. As a Locus user, I want the main Atlas view to remain useful before I choose a home base, so that setup is not a blocking wizard.
63. As a Locus user, I want confirmed Places and home base included in Library export, so that my organization survives backup and restore.
64. As a Locus user, I want analyzer credentials excluded from Library export, so that a backup contains my data but not secrets.
65. As a Locus user, I want inferred suggestions included in export only when they are durable Library state, so that restore does not depend on reconstructing the previous screen.
66. As a Locus user, I want a restored Library to preserve my overrides and Not for Atlas decisions, so that restore does not trigger a cleanup session.
67. As a Locus user, I want deleting an Item to remove its Atlas assignment without deleting a reusable Place, so that other Items remain organized.
68. As a Locus user, I want deleting an unused custom Place handled safely, so that a Place referenced by home base or another Item is never orphaned accidentally.
69. As a Locus user, I want Atlas to keep working when automatic analysis is unavailable, so that provider configuration is an enhancement rather than access to my own data.
70. As a Locus user, I want unresolved Travel Items visible when analysis is unavailable, so that failure is honest rather than silent.
71. As a Locus user, I want manual exact placement available without network access, so that local-first ownership is preserved.
72. As a Locus user, I do not want captions sent repeatedly or unnecessarily, so that automatic enrichment has a bounded privacy cost.
73. As a Locus user, I want captured Item text treated as untrusted input, so that instructions inside a post cannot control the analyzer or application.
74. As a Locus user, I want malformed provider output rejected atomically, so that partial or invented Place rows are not stored.
75. As a Locus user, I want place names and evidence sanitized before display, so that captured or generated text cannot become executable interface content.
76. As a Locus user, I want the current 44 Travel Items reconsidered by the new system, so that old word-matcher mistakes are not grandfathered in.
77. As a Locus user, I want all existing Items considered during backfill, so that local places outside the Travel tag can enter Atlas.
78. As a Locus user, I want current inferred region placements discarded rather than imported as truth, so that the new Atlas starts from evidence and explicit decisions.
79. As a Locus user, I want new Items queued after capture without changing the Capture Protocol, so that location enrichment remains a desk concern.
80. As a Locus user, I want an updated captured title or body to make an unconfirmed Item eligible for reanalysis, so that better captured text can improve suggestions.
81. As a Locus user, I want the Travel tag left intact when automatic Place assignment succeeds, so that location enrichment does not unexpectedly rewrite my tags.
82. As a Locus user, I want Not for Atlas to remove a mistaken automatic Travel membership only when I choose that correction, so that user intent controls topic cleanup.
83. As a developer, I want Atlas behavior behind one module, so that UI, HTTP, background work, export, and a later scratch pad do not each invent location rules.
84. As a developer, I want provider adapters to submit a bounded structured proposal to that module, so that provider-specific prompting cannot bypass domain validation.
85. As a developer, I want arbitrary Place fixtures to work in tests, so that passing tests do not depend on a hidden list of known countries or cities.
86. As a developer, I want the Atlas UI to consume a ready projection, so that it contains no geography regexes or region configuration.
87. As a developer, I want the later Atlas scratch pad to reference durable Places, so that itinerary stops do not rediscover locations from free text.
88. As a Locus user, I want fixing Atlas location data not to create an itinerary automatically, so that Library organization and trip planning remain separate actions.

## Implementation Decisions

- Add one deep **Atlas module** between Items, analyzer adapters, persistence, HTTP routes, export/import, and the Atlas UI. Callers may ask the module for the Atlas projection and perform explicit operations, but they do not know table layout, confidence rules, source-revision rules, Place deduplication, grouping, or override precedence.
- The primary testing and behavior seam is this Atlas module. The analyzer, HTTP layer, and React page are thin adapters. A later scratch-pad adapter must also consume this module rather than parsing Item text independently.
- Define these Atlas domain concepts:
  - **Place** — a reusable, user-visible geographic or visitable entity known to the Library. It has a canonical display name, a kind, an optional parent Place, alternate names, and optional coordinates or external identifier. A Place is not a tag or Collection.
  - **Place Assignment** — one Item's durable Atlas classification, including its outcome, primary Place when applicable, actor, evidence, source revision, and contained or mentioned Places.
  - **Place Suggestion** — a bounded analyzer proposal awaiting validation or user choice. It is not a confirmed Place Assignment.
  - **home base** — the one user-selected Place used to project a local Atlas section. It is configuration, not a special Place kind.
- Add these terms to the domain glossary when implementation begins. Continue to use **Item**, **Library**, **capture**, tag, and Collection as already defined; never call Atlas processing “sync.”
- Remove the source-code place-name list, the compiled place regular expressions, the five hand-written regions, and the functions that expose them. Do not retain them as fallback behavior or migration input.
- No country, city, venue, spelling, demonym, region membership, or home city is encoded in application source. Generic UI styling may use a fixed palette, but colors and motifs must not carry geographic classification. If stable per-Place accents are desired, derive them generically from Place identity.
- Atlas membership is independent of topic tags. A resolved Place Assignment with outcome `placed` or `multiple` makes an Item visible in Atlas. An unresolved Item already carrying a Travel tag remains visible in Needs a place. The analyzer may consider all Items; it must not use a hard-coded allowlist of tags to decide eligibility.
- Analysis has two semantic steps behind provider-neutral interfaces:
  1. **Interpretation** decides Atlas relevance and the roles of geographic mentions from bounded Item title/body input.
  2. **Resolution** normalizes proposed names and hierarchy against Places already known to the Library or proposes new structured Places.
- The first implementation uses the Pi SDK for both steps. Pi is the server-side model-routing layer: it selects among providers and models supported by the installed Pi version, including configured OpenAI-compatible endpoints. Atlas does not implement a second provider client or require a compiled gazetteer. A future local or remote gazetteer can implement the same resolution interface without changing Atlas policy.
- Pi credentials are deployment configuration, never Library data. A local installation may use Pi's local authentication store populated through `pi` login. A hosted installation supplies a supported provider credential through server environment/secret configuration. The same Atlas analyzer adapter and validated proposal contract serve both environments; no provider credential or Pi authentication state is sent to the browser, stored in Atlas tables, or included in Library export.
- Exact human override is not dependent on a remote geocoder. The picker searches existing Library Places first and permits a sanitized custom Place with kind and optional parent. This is the authoritative escape hatch for venues, misspellings, offline use, and provider failure.
- Analyzer input contains only the bounded fields required for classification: Item id, title, body, source URL/host context when useful, and current non-secret tag names when useful. Captured content is explicitly untrusted and cannot issue instructions.
- Analyzer output is a structured proposal containing only known Item ids, an Atlas relevance outcome, up to three ranked destination candidates, candidate hierarchy, role (`primary`, `contained`, or `mentioned`), and exact evidence spans or an explicit absence of evidence. Reject unknown ids, unknown roles, overlong strings, invalid hierarchies, unsupported evidence, excess candidates, and malformed values atomically.
- Do not rely on a numeric confidence score alone. A proposal may be auto-placed only when it declares one clear primary destination, provides valid supporting evidence, and contains no competing peer destination. Otherwise it becomes Needs a place or Multiple destinations.
- A Place Assignment outcome is one of `placed`, `needs_place`, `multiple`, or `not_atlas`.
- A placed assignment has exactly one primary Place. It may also relate ordered contained Places and mentioned Places. Mentioned Places never create sections, membership, or duplicate cards.
- A multiple assignment has at least two peer destination Places when known and renders once in Multiple destinations. It does not choose a silent primary merely to fit the index.
- A needs-place assignment stores up to three validated suggestions and their evidence. Suggestions do not count as destination membership until auto-placement or human selection.
- A not-for-Atlas assignment has no primary Place. Human not-for-Atlas decisions are durable and suppress future automatic inclusion.
- Assignment actor is `analyzer` or `user`. A user assignment is authoritative. Reanalysis may record that source content changed, but it cannot replace, downgrade, or augment a user-confirmed assignment without a new user action.
- Derive a source revision from normalized Item title and body. Skip analyzer work when that revision already has a terminal automatic result. A changed revision requeues only non-user-authoritative assignments.
- Record bounded attempt state so queued, running, succeeded, failed, and retryable analysis can survive process restart. Failure retains the last valid assignment and records a safe failure reason; it never partially replaces Atlas data.
- Analyze every existing Item during a versioned backfill and enqueue every newly inserted or materially updated Item after its Item transaction commits. This is desk-side enrichment; capture producers, site packs, Capture Protocol messages, and capture tokens do not change.
- Backfill does not convert current render-time matches into assignments because they were never durable user choices. Existing Travel Items remain discoverable through Needs a place while awaiting analysis. All other Items are also eligible for analysis so local saves can be found.
- Automatic analysis runs in bounded batches through Pi. Page render does not invoke the analyzer, and opening Atlas does not resubmit unchanged Items.
- Provider unavailability is represented separately from Item outcome. Atlas continues to serve confirmed/inferred stored assignments, exact manual placement, home-base configuration, and unresolved Travel review without the provider.
- Persist reusable Places separately from Item assignments. Place identity is generated by Locus and does not require an external provider id. Normalize comparison keys from the complete stored hierarchy and alternate names, but keep user-facing spelling intact. Do not merge two Places solely because their leaf names match under different parents.
- A Place has a kind drawn from a bounded general vocabulary such as country, administrative area, city, neighbourhood, venue, landmark, or natural area. Unknown future provider kinds map to a generic place kind rather than extending a geographic source-code taxonomy.
- Parent links must be acyclic. A Place cannot parent itself or one of its ancestors. Changing or deleting Places must preserve assignments and home-base referential integrity.
- Coordinates and external provider identifiers are optional metadata. Atlas grouping in this release depends on stored parent relationships, not coordinate availability.
- Store Item-to-Place roles separately enough that one assignment can have one primary, several contained Places, and several mentioned Places without duplicating the Item. Enforce one primary Place for a placed assignment at the module boundary and database level where practical.
- Store suggestions separately from accepted roles or as bounded validated proposal data owned by the assignment. Suggested Places must not silently become confirmed hierarchy simply because a model emitted them.
- Store one home-base Place reference for the local Library. No source-code default is set. Home-base selection is optional and may point to a user-created Place.
- The Around home projection contains Items whose primary Place is the home base or a descendant of it. Do not infer a radius without coordinates and an explicit product decision. Items outside that hierarchy remain under their normal destinations.
- Changing home base changes projection only. It does not rewrite Place Assignments, tags, Collections, notes, or Items.
- Destination projection groups placed Items through their stored hierarchy and orders groups deterministically. An Item appears in exactly one main destination group or the Around home group; its contained and mentioned Places are metadata, not duplicate group membership.
- Around home is shown first when configured and non-empty. Other destinations follow in a stable human-readable order. Multiple destinations and Needs a place are separate single-instance groups.
- The Atlas response returns ready-to-render sections, distinct Item counts, home-base state, analysis availability/progress, a compact Needs-a-place preview, and a paginated or bounded complete review collection. The UI does not reconstruct hierarchy or confidence policy.
- Compose the Atlas page from **Atlas UI kit**. Do not invent a second layout or pull Kanban, Data grid, Command, Cascader, or Tree from the throwaway prototype.
- The Atlas page uses Reading’s visual hierarchy (type, density, quiet counts) rather than Reading’s domain language. Label the staging area **Needs a place**, not Preparing, because it is awaiting a human decision rather than merely background work.
- Needs a place sits before the main destination sections as an Alert with count and preview. Review reveals all reviewable rows in normal page flow. Do not hide unresolved Items in a bottom disclosure.
- Each review row shows recognizable Item identity and the evidence associated with each suggestion. It exposes separate buttons: select suggestion, Choose exact place, Multiple destinations, Not for Atlas, and leave unresolved.
- Choosing a suggestion, exact Place, Multiple destinations, or Not for Atlas updates the Atlas projection immediately without a full-page race that briefly displays both old and new groups.
- Every inferred placed Item exposes a quiet Change place control (quiet text, not a Badge). User-confirmed Items may expose the same control without an “error” treatment. Changing the Place is an ordinary correction, not a tag edit.
- Exact place and Change place open a Combobox in a Sheet. The Combobox searches known Places by canonical name and alternate names, shows enough parent hierarchy to distinguish duplicates, and offers creation when no result matches. It is not an embedded web search engine. Home-base unset uses the same Alert pattern as Needs a place; choosing home may reuse the Sheet Combobox.
- Not for Atlas records a user-authoritative Atlas decision. If the Item's Travel tag membership was automatically authored, the correction may remove that mistaken membership in the same transaction. Never remove a user-authored Travel tag without a separate explicit confirmation. If current membership provenance cannot distinguish this safely, preserve the tag and suppress only Atlas membership in this release.
- Atlas writes use the existing session, CSRF, loopback, sanitization, and error conventions. Clients cannot submit assignment actor, source revision, confidence, or Library id as trusted values.
- Expose module-backed HTTP operations for: read Atlas projection; read/search Places; choose or create home base; accept a suggestion; set an exact Place; mark multiple; mark Not for Atlas; leave/reopen unresolved; change a Place; retry analysis for an Item; and request/resume bounded backfill. UI and future agents call these operations rather than tables.
- Manual mutation operations return the updated Item classification and affected Atlas projection fragment or enough version information for a safe refetch. Use stale-write protection so two tabs cannot silently overwrite a newer human correction.
- Add all durable Atlas tables and non-secret home-base state to the versioned Library archive. Import validates Place hierarchy, assignment invariants, Item references, evidence bounds, actor values, source revisions, and home-base references before committing atomically.
- Archive restore preserves user decisions exactly. Analyzer attempt bookkeeping that is purely operational may be rebuilt; accepted inferred assignments and review suggestions are durable if the UI depends on them after restore.
- Item deletion cascades its assignments, suggestions, and attempts. It does not automatically delete reusable Places. A Place referenced by any assignment, child Place, or home base cannot be deleted. Cleanup of unreferenced analyzer-created Places may be explicit or deferred.
- The current Atlas tab is replaced in place; this work does not add another navigation destination. Existing Item opening and safe media/preview behavior remain available on Atlas cards.
- The final scratch-pad specification must replace Atlas's free-text placement assumption with a reference to this durable Place model where a known Place exists. A pad itinerary still owns day and stop order. Assigning an Item to a Library Place does not pin it to a trip, and moving a trip stop does not rewrite its Library Place Assignment.

## Atlas UI kit

Locked page composition. Open this file before writing Atlas UI:

`.scratch/atlas/prototype.html?needs=alert&picker=combobox&shell=sheet&dest=cards&actions=buttons&inferred=quiet&home=alert`

That query string is the decision. Preset A (plates) plus two overrides: Needs a place is an Alert, picker shell is a Sheet.

| Slot | Choice | Catalog page the prototype borrowed |
| --- | --- | --- |
| Needs a place | Alert | https://reui.io/components/alert |
| Place picker | Combobox | https://reui.io/components/combobox |
| Picker shell | Sheet | https://reui.io/components/sheet |
| Destinations | Cards (existing Atlas plates) | https://reui.io/components/card |
| Review actions | Buttons | https://reui.io/components/button |
| Inferred mark | Quiet text | — |
| Home base | Alert | https://reui.io/components/alert |

Implement these patterns with Locus tokens and existing Atlas CSS. ReUI is the reference for interaction shape, not a package to install. The prototype is throwaway and is not production UI.

## Testing Decisions

- Test external behavior primarily through the Atlas module with a real in-memory SQLite database. Feed it Items, validated analyzer proposals, and user commands; assert the resulting projection and durable state. Do not test React implementation details or private SQL helpers.
- The highest seam covers Place creation/search, hierarchy validation, assignment transitions, analyzer/user precedence, home-base projection, backfill state, and grouping. This is intentionally one primary seam so HTTP, UI, background worker, and later scratch-pad adapters share the same behavior.
- Use arbitrary and invented Place names in core tests. A test should be able to create “Northstar City” under “Exampleland,” assign an Item, choose it as home base, and receive the correct projection without changing production code. This is the regression proof that geography is data rather than a hidden allowlist.
- Test the motivating ambiguity with a deterministic proposal fixture: Philippines is primary; India and Mumbai are mentioned/origin context. Assert that the Item appears once under Philippines and never under India.
- Test comparison context with a primary destination and a mentioned comparison Place. Assert only the primary creates membership.
- Test a genuine multi-destination proposal. Assert the Item appears exactly once in Multiple destinations and counts once.
- Test one primary destination with several contained cities. Assert the Item appears once under the primary and exposes contained places as metadata.
- Test a geographic false positive such as a product title containing a country. Given a not-for-Atlas proposal, assert it does not appear in destination sections.
- Test a resolved Food Item without a Travel tag. Assert it appears in Atlas while its tags and Kitchen eligibility remain unchanged.
- Test an unresolved Travel Item with analysis unavailable. Assert it remains in Needs a place and can be placed manually.
- Test a non-Travel Item with no assignment. Assert it does not flood Needs a place merely because the provider is unavailable.
- Test up to three suggestions, ranked evidence, invalid fourth suggestions, missing evidence, evidence outside source bounds, unknown Item ids, malformed kinds, and overlong names.
- Test that malformed analyzer output writes nothing. Preserve the prior valid assignment and attempt history appropriate to the failure.
- Test that one clear validated proposal may create an inferred placed assignment, while competing peer candidates become Needs a place and genuine peers become Multiple destinations.
- Test accepting each suggestion and exact custom Place creation. Assert the row leaves Needs a place and enters the correct section immediately.
- Test Leave unresolved. Assert it stays reviewable without manufacturing a destination.
- Test Change place. Assert the Item disappears from the old section, appears once in the new section, and distinct counts remain correct.
- Test a user override followed by a new automatic proposal and by a changed source revision. Assert the human assignment remains authoritative.
- Test an inferred assignment followed by changed source text. Assert it becomes eligible for reanalysis without losing the last valid projection during a failed attempt.
- Test a human Not for Atlas decision followed by reanalysis. Assert it remains suppressed.
- Test automatic versus user-authored Travel tag cleanup according to available membership provenance. Never assert deletion of a user tag without explicit confirmation.
- Test alternate-name search and same-leaf-name Places under different parents. Assert search disambiguates them and no unsafe merge occurs.
- Test Place parent cycles, self-parenting, missing parents, deletion while referenced, and deletion of an unreferenced custom Place.
- Test home base unset, set, changed, and restored. Assert no home setup blocks normal destination browsing.
- Test a primary Place equal to home base and a descendant Place. Assert both appear under Around home. Assert a sibling or unrelated Place does not.
- Test that changing home base changes only projection and never mutates assignments, Items, tags, notes, or Collections.
- Test exact placement and home-base use with no coordinates or external identifier. Core behavior must not require a geocoder.
- Test analysis queue idempotency by source revision, bounded batches, restart/resume, retryable failure, and new Item enqueue after capture transaction completion.
- Do not call a live model or geocoder in deterministic tests. Analyzer-adapter tests use fixtures or a fake provider and assert strict validation at the Atlas module boundary. A manual smoke test may exercise configured analysis against a disposable database.
- Add HTTP integration tests following the existing server test style. Verify session/CSRF rules, payload bounds, stale-write rejection, updated response shape, unavailable-provider behavior, and errors for missing Items or Places.
- Add Library archive round-trip and hostile-import tests following existing archive test prior art. Verify Place hierarchy, assignments, suggestions needed by the UI, home base, user authority, and absence of provider secrets.
- Add a focused UI smoke test only for behavior that the module cannot prove: Needs-a-place collapsed/expanded accessibility, exact-place control reachability, immediate row movement, Change place availability, and absence of duplicate Item keys/cards. Do not snapshot geography, colors, or complete DOM markup.
- Replace the old pure word-matcher tests. No test may bless a compiled inventory of supported places or regions.
- Regression-test retained routes and Item opening from Atlas. Do not boot live Chrome, extension producers, or site packs.
- A good test describes a user-visible invariant: “a Philippines destination mentioning Mumbai appears once under Philippines.” A poor test asserts which regex ran, which table was queried, the analyzer prompt text, or a particular CSS class.

## Out of Scope

- The collaborative scratch pad, itinerary days, route order, holes, candidates, annotations, and WebMCP tools. This spec supplies the durable Place foundation they will later consume.
- Route optimization, transit planning, travel times, opening hours, booking, budgets, weather, or itinerary generation.
- A live geographic map, map tiles, geospatial drawing, distance-radius search, or turn-by-turn directions.
- Requiring coordinates for Place identity or Atlas grouping.
- Choosing or operating a third-party geocoding service. Pi is the decided v1 model-routing layer; a future gazetteer adapter may improve normalization through the defined resolution seam, but manual exact Place creation and core Atlas behavior cannot depend on it.
- Shipping a global offline gazetteer inside the application.
- Crawling the open web to discover destinations, venues, or addresses.
- OCR, audio transcription, Reel/video inspection, media downloading, or claims based on inaccessible media.
- Rewriting the global topic-tagging system. This work only separates Atlas membership from topic tags and provides a safe correction for mistaken Atlas inclusion.
- Changing capture producers, extension or runner behavior, site packs, Capture Protocol messages, or capture tokens.
- Multiple home bases, temporary trip origins, radius-based “near home,” or automatic relocation detection.
- Shared Libraries, multi-user conflict policy, public Atlas pages, or cloud accounts.
- Automatically deleting old or unused Places without an explicit retention policy.
- Hard-coding a replacement list of countries, cities, aliases, regions, or demonyms in tests, migrations, prompts, UI, or server code.

## Further Notes

- The current Library evidence was inspected read-only. Existing inferred Atlas placement is entirely ephemeral, so there are no user corrections to migrate from the current implementation.
- Reading is a typography and density reference only. **Needs a place** is an Alert (see **Atlas UI kit**), not Reading’s Preparing disclosure, because the row may wait indefinitely for a user choice and must not imply that a background job will certainly resolve it.
- Automatic analysis is useful triage, not authority. The central product promise is that ambiguity becomes a small visible choice and that a human correction stays corrected.
- **Travel** remains a topic tag. **Place Assignment** answers a different question: whether and where an Item belongs in Atlas.
- Around home is a hierarchy projection, not a tag, Collection, copied assignment, or promise of physical distance.
- Multiple destinations is a first-class outcome, not an error and not permission to duplicate a card into every mentioned section.
- The no-hardcoding requirement applies across runtime code, UI configuration, migrations, prompts used as lookup tables, and tests. Prompt examples may illustrate roles, but they must not become an exhaustive geography taxonomy.
- This spec should be implemented after the Kitchen work currently in progress and before finalizing the scratch-pad specification, so the later Atlas job starts from trustworthy Library Places rather than caption parsing or free-text stop names.
