const MEDIA_SCHEMA = {
  type: "array",
  maxItems: 8,
  items: {
    type: "object",
    properties: {
      kind: { type: "string" },
      url: { type: "string", maxLength: 2000 },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    tagId: { type: "string", minLength: 1, maxLength: 80 },
    rationale: { type: "string", minLength: 1, maxLength: 280 },
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["title", "body", "authorName", "url", "instruction"] },
          text: { type: "string", minLength: 1, maxLength: 280 },
        },
        required: ["field", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["tagId", "rationale", "evidence"],
  additionalProperties: false,
};

export const CREATE_ITEMS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    clientMutationId: { type: "string", minLength: 1, maxLength: 100 },
    contextVersion: { type: "string", minLength: 1, maxLength: 100 },
    instruction: { type: "string", maxLength: 500 },
    drafts: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, maxLength: 2000 },
          title: { type: "string", maxLength: 500 },
          body: { type: "string", maxLength: 20000 },
          authorName: { type: "string", maxLength: 200 },
          publishedAt: { type: "string", maxLength: 40 },
          media: MEDIA_SCHEMA,
          observedFields: {
            type: "array",
            maxItems: 5,
            items: { type: "string", enum: ["title", "body", "authorName", "publishedAt", "media"] },
          },
          tagIds: { type: "array", maxItems: 12, items: { type: "string", maxLength: 80 } },
          collectionIds: { type: "array", maxItems: 5, items: { type: "string", maxLength: 80 } },
          classifications: { type: "array", maxItems: 12, items: CLASSIFICATION_SCHEMA },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  required: ["clientMutationId", "contextVersion", "drafts"],
  additionalProperties: false,
};
