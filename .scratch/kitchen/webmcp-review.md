# Kitchen WebMCP review and follow-up

Status: shared WebMCP module documented for follow-up

## Architecture decision

Locus currently has four page-defined WebMCP adapters:

- `app/src/reading-webmcp.ts`
- `app/src/trips-webmcp.ts`
- `app/src/kitchen-recipe-webmcp.ts`
- `app/src/kitchen-tonight-webmcp.ts`

All four repeat the same runtime mechanics: WebMCP detection, standard and legacy registration, one-active-registration cleanup, `AbortSignal` handling, asynchronous registration failure handling, diagnostics, and HTTP/tool error translation. Those mechanics should move behind one shared WebMCP module used by every adapter.

The shared module should own:

- the common tool, runtime, diagnostics, and stable error types;
- detection of `document.modelContext` and the supported legacy runtime;
- one document-level active registration scope;
- registration, replacement, abort, and asynchronous failure cleanup;
- the common execution/diagnostics wrapper, with error classification supplied through a small interface where domain behavior differs.

The domain adapters should continue to own:

- tool names, descriptions, annotations, and input schemas;
- input parsing and bounds;
- visible-route and explicit-consent policy;
- projections, host interfaces, and domain handlers;
- Reading, Trips, Recipe Document, and Tonight behavior.

Do not make one file that contains every WebMCP tool. The target is a deep shared module for runtime mechanics with thin domain-specific registration calls. Kitchen Recipe and Kitchen Tonight may remain separate tool-set builders because they belong to different visible surfaces and require different host interfaces. A shared registration module should make merging those domain adapters unnecessary.

A suitable shared interface is approximately:

```ts
attachWebmcpSurface({
  tools,
  log,
  classifyError,
  globalObj,
}): () => void
```

The exact type shape may differ, but callers should supply tools and domain-specific error classification while the shared module owns runtime discovery and lifecycle. Because Locus displays one route at a time, registering a new surface should abort the previous document-level registration automatically.

Track behavior fixes separately and land their focused regression tests before moving shared infrastructure.
