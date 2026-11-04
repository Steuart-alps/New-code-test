import assert from "node:assert/strict";
import { compareContracts, formatFinding } from "../scripts/contract-diff.mjs";

// Each case starts from the same small contract, changes one thing, and checks
// whether the API contract check calls it breaking (and names the operation
// and field), a warning, or fine.

const base = () => ({
  openapi: "3.1.0",
  paths: {
    "/sites": {
      get: {
        operationId: "listSites",
        parameters: [
          { in: "query", name: "status", schema: { type: "string", enum: ["open", "closed"] } },
        ],
        responses: {
          200: {
            description: "Sites",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Site" } } } },
          },
        },
      },
      post: {
        operationId: "createSite",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateSite" } } },
        },
        responses: {
          201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Site" } } } },
          400: { description: "Invalid" },
        },
      },
    },
    "/sites/{id}": {
      delete: {
        operationId: "deleteSite",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: { 204: { description: "Deleted" } },
      },
    },
  },
  components: {
    schemas: {
      Site: {
        type: "object",
        required: ["id", "name", "kind"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          kind: { type: "string", enum: ["office", "kitchen"] },
          openedAt: { type: "string", format: "date-time" },
          manager: { anyOf: [{ $ref: "#/components/schemas/Person" }, { type: "null" }] },
        },
      },
      Person: { type: "object", required: ["id"], properties: { id: { type: "integer" }, name: { type: "string" } } },
      CreateSite: {
        allOf: [
          { $ref: "#/components/schemas/SiteFields" },
          { type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 200 } } },
        ],
      },
      SiteFields: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["office", "kitchen"] },
          notes: { type: ["string", "null"] },
        },
      },
    },
  },
});

const schemas = (doc) => doc.components.schemas;

function check(name, change, expected) {
  const current = base();
  change(current);
  const result = compareContracts(base(), current);
  const breaking = result.breaking.map(formatFinding);
  const warnings = result.warnings.map(formatFinding);
  try {
    assert.deepEqual(breaking, expected.breaking ?? [], "breaking changes");
    assert.deepEqual(warnings, expected.warnings ?? [], "warnings");
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}\n${error.message}`);
    process.exitCode = 1;
  }
}

check("identical contracts", () => {}, {});

// Additive, backwards-compatible changes stay allowed.
check("new endpoint, optional request field, response field and optional query parameter", (doc) => {
  doc.paths["/sites/{id}"].get = { operationId: "getSite", responses: { 200: { description: "Site" } } };
  schemas(doc).SiteFields.properties.postcode = { type: "string" };
  schemas(doc).Site.properties.postcode = { type: "string" };
  schemas(doc).Site.required.push("postcode");
  doc.paths["/sites"].get.parameters.push({ in: "query", name: "search", schema: { type: "string" } });
}, {});
check("request accepts a new enum value, null, a wider type and a longer name", (doc) => {
  schemas(doc).SiteFields.properties.kind.enum.push("warehouse");
  schemas(doc).CreateSite.allOf[1].properties.name = { type: ["string", "null"], maxLength: 500 };
}, {});
check("dropped error response", (doc) => {
  delete doc.paths["/sites"].post.responses[400];
}, {});
check("renamed path parameter", (doc) => {
  doc.paths["/sites/{siteId}"] = doc.paths["/sites/{id}"];
  delete doc.paths["/sites/{id}"];
  doc.paths["/sites/{siteId}"].delete.parameters[0].name = "siteId";
}, {});

// Removed endpoints.
check("removed operation", (doc) => {
  delete doc.paths["/sites/{id}"];
}, { breaking: ["DELETE /sites/{id} (deleteSite): operation removed"] });
check("removed success response", (doc) => {
  doc.paths["/sites"].post.responses = { 200: doc.paths["/sites"].post.responses[201] };
}, { breaking: ["POST /sites (createSite) response 201: response removed"] });

// Narrowed or newly required request fields.
check("request field becomes required", (doc) => {
  schemas(doc).SiteFields.required = ["kind"];
}, { breaking: ["POST /sites (createSite) request body.kind: now required"] });
check("new required request field", (doc) => {
  schemas(doc).CreateSite.allOf[1].required.push("region");
  schemas(doc).CreateSite.allOf[1].properties.region = { type: "string" };
}, { breaking: ["POST /sites (createSite) request body.region: new required field"] });
check("request enum value removed and max length tightened", (doc) => {
  schemas(doc).SiteFields.properties.kind.enum = ["office"];
  schemas(doc).CreateSite.allOf[1].properties.name.maxLength = 100;
}, {
  breaking: [
    "POST /sites (createSite) request body.kind: enum value \"kitchen\" removed",
    "POST /sites (createSite) request body.name: maxLength tightened from 200 to 100",
  ],
});
check("request field no longer accepts null", (doc) => {
  schemas(doc).SiteFields.properties.notes = { type: "string" };
}, { breaking: ["POST /sites (createSite) request body.notes: no longer accepts null"] });
check("request field removed", (doc) => {
  delete schemas(doc).SiteFields.properties.notes;
}, { breaking: ["POST /sites (createSite) request body.notes: field no longer accepted"] });
check("query parameter removed and new required parameter", (doc) => {
  doc.paths["/sites"].get.parameters = [{ in: "query", name: "region", required: true, schema: { type: "string" } }];
}, {
  breaking: [
    "GET /sites (listSites) query parameter status: parameter removed",
    "GET /sites (listSites) query parameter region: new required parameter",
  ],
});
check("path parameter type narrowed", (doc) => {
  doc.paths["/sites/{id}"].delete.parameters[0].schema = { type: "string", format: "uuid" };
}, {
  breaking: [
    "DELETE /sites/{id} (deleteSite) path parameter id: type narrowed from integer to string",
    "DELETE /sites/{id} (deleteSite) path parameter id: now requires format uuid",
  ],
});

// Incompatible response changes, reported once per affected operation.
check("response field removed", (doc) => {
  delete schemas(doc).Site.properties.name;
  schemas(doc).Site.required = ["id", "kind"];
}, {
  breaking: [
    "GET /sites (listSites) response 200[].name: field removed",
    "POST /sites (createSite) response 201.name: field removed",
  ],
});
check("response field no longer required, now nullable, type and format changed", (doc) => {
  schemas(doc).Site.required = ["id", "kind"];
  schemas(doc).Site.properties.name = { type: ["string", "null"] };
  schemas(doc).Site.properties.id = { type: "string" };
  schemas(doc).Site.properties.openedAt = { type: "string", format: "date" };
}, {
  breaking: [
    "GET /sites (listSites) response 200[].id: type changed from integer to string",
    "GET /sites (listSites) response 200[].name: no longer always present (was required)",
    "GET /sites (listSites) response 200[].name: can now be null",
    "GET /sites (listSites) response 200[].openedAt: format changed from date-time to date",
    "POST /sites (createSite) response 201.id: type changed from integer to string",
    "POST /sites (createSite) response 201.name: no longer always present (was required)",
    "POST /sites (createSite) response 201.name: can now be null",
    "POST /sites (createSite) response 201.openedAt: format changed from date-time to date",
  ],
});
check("nested response object loses a field", (doc) => {
  delete schemas(doc).Person.properties.name;
}, {
  breaking: [
    "GET /sites (listSites) response 200[].manager.name: field removed",
    "POST /sites (createSite) response 201.manager.name: field removed",
  ],
});
check("response media type removed", (doc) => {
  doc.paths["/sites"].get.responses[200].content = { "text/csv": { schema: { type: "string" } } };
}, { breaking: ["GET /sites (listSites) response 200: application/json no longer returned"] });

// New response enum values are flagged but do not fail the check.
check("new response enum value is a warning", (doc) => {
  schemas(doc).Site.properties.kind.enum.push("warehouse");
}, {
  warnings: [
    "GET /sites (listSites) response 200[].kind: new enum value \"warehouse\" (old clients may not handle it)",
    "POST /sites (createSite) response 201.kind: new enum value \"warehouse\" (old clients may not handle it)",
  ],
});

if (process.exitCode) console.error("API contract diff tests failed.");
else console.log("API contract diff tests passed.");
