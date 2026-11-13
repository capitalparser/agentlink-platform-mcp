import assert from "node:assert/strict";

export const CAPABILITY_KEYS = Object.freeze([
  "task_guidance",
  "rule_evaluation",
  "monetary_calculation",
  "evidence_retrieval",
]);

export const GUIDANCE_CAPABILITIES = Object.freeze({
  task_guidance: "available",
  rule_evaluation: "not_implemented",
  monetary_calculation: "not_implemented",
  evidence_retrieval: "current_law_context",
});

export const WITHHOLDING_CAPABILITIES = Object.freeze({
  task_guidance: "existing_workflow",
  rule_evaluation: "available",
  monetary_calculation: "conditional_supported_profiles",
  evidence_retrieval: "evaluated_rule_sources",
});

export const WORKFLOW_EXPECTATIONS = Object.freeze([
  Object.freeze({ id: "withholding-payment", status: "implemented", capabilities: WITHHOLDING_CAPABILITIES }),
  ...[
    "corporate-adjustment",
    "income-return",
    "vat-return",
    "international-transaction",
    "tax-credit",
    "local-tax-event",
    "tax-procedure-case",
    "estate-gift-event",
    "capital-gains-return",
    "comprehensive-property-holding",
  ].map((id) => Object.freeze({ id, status: "contract_only", capabilities: GUIDANCE_CAPABILITIES })),
]);

export const FOCUS_EXPECTATIONS = Object.freeze([
  Object.freeze({ workflow_id: "corporate-adjustment", focus: "expense-review", law_id: "001563", article: "제19조" }),
  Object.freeze({ workflow_id: "corporate-adjustment", focus: "closing-reconciliation", law_id: "001563", article: "제60조" }),
  Object.freeze({ workflow_id: "income-return", focus: "return-scope", law_id: "001565", article: "제70조" }),
  Object.freeze({ workflow_id: "income-return", focus: "bookkeeping-review", law_id: "001565", article: "제160조" }),
  Object.freeze({ workflow_id: "vat-return", focus: "purchase-review", law_id: "001571", article: "제39조" }),
  Object.freeze({ workflow_id: "vat-return", focus: "filing-reconciliation", law_id: "001571", article: "제49조" }),
  Object.freeze({ workflow_id: "international-transaction", focus: "individual-recipient", law_id: "001565", article: "제119조" }),
  Object.freeze({ workflow_id: "international-transaction", focus: "corporate-recipient", law_id: "001563", article: "제93조" }),
  Object.freeze({ workflow_id: "tax-credit", focus: "research-cost", law_id: "001584", article: "제10조" }),
  Object.freeze({ workflow_id: "tax-credit", focus: "overlap-review", law_id: "001584", article: "제127조" }),
  Object.freeze({ workflow_id: "local-tax-event", focus: "acquisition", law_id: "001649", article: "제7조" }),
  Object.freeze({ workflow_id: "local-tax-event", focus: "holding", law_id: "001649", article: "제104조" }),
  Object.freeze({ workflow_id: "tax-procedure-case", focus: "correction-request", law_id: "001586", article: "제45조의2" }),
  Object.freeze({ workflow_id: "tax-procedure-case", focus: "objection-review", law_id: "001586", article: "제55조" }),
  Object.freeze({ workflow_id: "estate-gift-event", focus: "event-classification", law_id: "001561", article: "제2조" }),
  Object.freeze({ workflow_id: "estate-gift-event", focus: "valuation-preparation", law_id: "001561", article: "제60조" }),
  Object.freeze({ workflow_id: "capital-gains-return", focus: "asset-scope", law_id: "001565", article: "제94조" }),
  Object.freeze({ workflow_id: "capital-gains-return", focus: "cost-review", law_id: "001565", article: "제97조" }),
  Object.freeze({ workflow_id: "comprehensive-property-holding", focus: "housing-holdings", law_id: "009873", article: "제7조" }),
  Object.freeze({ workflow_id: "comprehensive-property-holding", focus: "land-holdings", law_id: "009873", article: "제12조" }),
]);

export function assertWorkflowMatrix(workflows) {
  assert.ok(Array.isArray(workflows), "workflow list must be an array");
  const ids = workflows.map((workflow) => workflow?.id);
  assert.equal(new Set(ids).size, ids.length, "workflow IDs must not be duplicated");
  assert.deepEqual([...ids].sort(), WORKFLOW_EXPECTATIONS.map(({ id }) => id).sort(),
    "installed workflow IDs must match the independent review matrix");

  for (const expected of WORKFLOW_EXPECTATIONS) {
    const matches = workflows.filter((workflow) => workflow?.id === expected.id);
    assert.equal(matches.length, 1, `${expected.id} must appear exactly once`);
    assert.equal(matches[0].status, expected.status, `${expected.id} status drifted`);
    assert.deepEqual(matches[0].capabilities, expected.capabilities,
      `${expected.id} capabilities drifted`);
  }
}
