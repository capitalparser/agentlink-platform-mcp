# Tax-only MCP setup

This guide connects the upper MCP server to an installed tax-domain MCP package. The upper server starts and verifies the configured tax child before it accepts MCP connections, then advertises tax tools only after the child has listed and passed the expected tool-contract checks. Subsidy and demo tools are disabled by default.

## Required installed artifact

Use the authorized tax-domain Python wheel in a dedicated Python 3.12 environment. The wheel includes the matching canonical registry, so no separate registry artifact is required. Do not use a source checkout or `PYTHONPATH` as the runtime installation.

Create the environment and install the wheel supplied to you:

```sh
python3.12 -m venv /path/to/tax-venv
/path/to/tax-venv/bin/python -m pip install /path/to/authorized/tax-domain.whl
```

The installed server uses the registry bundled at `agentlink_tax/_registry` by default. `AGENTLINK_TAX_REGISTRY` is an optional exact-path override for compatibility. When set, that path replaces the bundled registry; an empty, missing, malformed, or invalid override fails startup without falling back to the bundle.

Use the Python MCP SDK 1.x dependency range supported by that wheel. If the child cannot complete MCP initialization because one of its imports is missing or has moved, ask the artifact owner for a compatible wheel or dependency set; installing the package alone does not establish runtime compatibility. The upper bridge reports only a safe status/error code and does not expose child tracebacks.

Install or build the upper MCP server through your approved package process. Its entry point is `dist/index.js` in the installed package.

## MCP client configuration

Add a server entry to the MCP client's configuration. Replace the placeholders with paths available to that client account:

```json
{
  "mcpServers": {
    "agentlink-tax": {
      "command": "node",
      "args": ["/path/to/upper-mcp/dist/index.js"],
      "env": {
        "AGENTLINK_TAX_MCP_COMMAND": "/path/to/tax-venv/bin/python",
        "AGENTLINK_TAX_MCP_ARGS": "[\"-B\",\"-m\",\"agentlink_tax.server\"]"
      }
    }
  }
}
```

`AGENTLINK_TAX_MCP_ARGS` is a JSON array encoded as a string. The Python interpreter must be the environment where the wheel was installed. The wheel installation removes the need for a separate registry artifact or a source-tree `PYTHONPATH`.

`tax_get_law_article` accepts an optional `lookup_basis` of `promulgation` or `effective`. Omitting it leaves the child tool's existing `promulgation` default in force; the upper server does not insert a value. `effective` lookup requires an explicit numeric `law_id`. Keep the upper package and tax wheel compatible: a newer upper contract is rejected during discovery when the installed child does not expose `lookup_basis`.

For `tax_answer_practitioner_question`, the upper server maps registered native names in root `next_actions[].tool.name` values to the public MCP tool names, such as `get_law_article` to `tax_get_law_article`. The action arguments and other action fields remain intact, and the returned JSON text stays in parity with `structuredContent`.

The default startup exposes the verified tax tools and `agentlink_bridge_status`. Optional subsidy tools remain unavailable until their domain is explicitly configured. Stub/demo tools require the explicit `AGENTLINK_DEMO_TOOLS=1` opt-in.

## Check readiness and recover

Call `agentlink_bridge_status` to inspect whether the tax domain is configured, its current state or safe error code, and the count/names of verified tools. It does not return local command lines, paths, credentials, child output, or tax facts.

If startup shows an unavailable tax domain, check that the configured interpreter can import the installed package and that its bundled registry is complete. If you deliberately set `AGENTLINK_TAX_REGISTRY`, also check that exact path; an invalid override does not use the bundled copy. Correct the client environment and restart the MCP server. If the configured paths are already correct and a transient startup issue has cleared, call `agentlink_bridge_status` with `{ "refresh": true }` to retry connection and contract verification. Tax tools are advertised only after a successful refresh.

Do not copy private configuration values into logs or support messages. If the status contains a fixed error code, use it to route diagnosis while keeping machine paths and credentials local.

## Result limits

`tax_plan_work` returns a review draft. It can calculate withholding for four explicitly selected payment profiles when all required user facts are present and the current-law basis is fetched and matched: `business_lecture` for continuing, repeated independent lectures; `other_lecture` for temporary lectures; `business_personal_service` for the ten supported continuing services selected by `service_subtype`; and `other_personal_service` for only three user-confirmed temporary other-income services selected by `other_service_subtype`. The new `manuscript_fee` type is Article 21(1)(15)(a) 원고료 paid to the original author of a qualifying creative work in literature, scholarship, art, music, or photography, including only the statutory qualifying illustrations and translations; it excludes 인세 under (b) and creative-work sale or other consideration under (c). `expert_advisory` is temporary paid use of professional knowledge or special skill under Article 21(1)(19)(c), excluding services under (15)–(17) and receipts of a professional practice or continuing business. `broadcast_commentary` is temporary explanation, enlightenment, or acting judging through radio, television, or analogous broadcasting media under Article 21(1)(19)(b); generic committee judging, online content, performances, and consulting do not qualify by label. For all three, the user must confirm that the receipt is outside interest, dividend, business, employment, pension, retirement, or capital-gain income, professional-practice or continuing-business revenue, royalties, license fees, rights transfers or use, and inseparable mixed consideration. A one-off payment does not establish that classification. For the supported OTHER profiles, the statute permits actual necessary expenses above the 60% standard allowance, including an amount above gross within the existing 1,000,000,000,000,000-won input limit. The calculator can use a user-supplied whole-won total only when the user confirms that it corresponds to this payment’s current-period receipts, is ordinary and deductible, exceeds the 60% standard amount, and is supported by records the payer can ascertain. This is an unverified user assertion: the calculator has not inspected or authenticated records. Allocation, depreciation, statutory limits, timing, duplicate deductions, or reimbursement questions require separate review. A computed actual-expense row is labeled `expense_method=actual`; `expense_amount` contains the supplied total, `expense_rate` is `null`, and any amount above gross appears separately as `expense_excess_amount`. When expenses exceed a payment’s gross amount, the signed payment-level OTHER difference remains negative in `income_amount`, while the withholding base and withholding for that payment are zero and net payment remains gross. This result covers one payment only; it does not calculate annual OTHER-income netting, offsets against other income, loss carryforward, refunds, or eligibility for them. This confirmation does not verify legal classification. The personal-service profile requires a resident individual receiving a domestic payment for the selected service provided independently and continuously, with no employment relationship, dedicated business facilities, hired employees, non-employment labor supplied for the service's main work, special tax treatment, or split payment; it does not require `lecture_to_many`. These are bounded user-supplied classifications, not a general freelancer, software, consulting, design, photography, or royalty classifier. Set `include_evidence=true`; without matched evidence or complete facts, the payment has no calculated amounts. These scoped payment results do not decide applicability for the whole matter, which remains `not_determined`, and they do not issue a final filing decision, file, or submit anything. The facts are user-supplied and pending review. An input `withheld_amount` remains the actual reported amount and is kept separate from the calculated amount. Unsupported payments and the ten other listed workflows including VAT remain outside this calculation scope; those workflows remain `contract_only` until separately implemented and verified.

The withholding deadline remains a candidate and must be checked against current rules and calendars. When the external holiday provider is unavailable, the result retains a warning that public and substitute holidays were not applied; that fallback is not verified holiday data. Missing facts stay as questions.

## Run the installed-child integration check

The offline integration test launches separate native and upper MCP stdio sessions against the installed Python wheel. It compares all 11 workflow contracts, then checks 10 overview and 20 focus plan/answer cases through both surfaces with independent expectations. For each practitioner answer, it checks the native and public law-tool names against `tools/list`, compares the four returned lookup arguments, and calls both returned actions. Credentials point to a nonexistent temporary file, so law calls stop with `credential_missing`; external evidence lookup is disabled. The test never calls the tax planner directly.

```sh
AGENTLINK_TEST_TAX_PYTHON=/path/to/tax-venv/bin/python \
AGENTLINK_TEST_UPPER_ENTRY=/path/to/installed/upper/dist/index.js \
npm run test:integration
```

`AGENTLINK_TEST_UPPER_ENTRY` must be an absolute path to an existing upper entry. Required integration mode does not fall back to the checkout build: point it at the installed upper package to check that artifact, or explicitly point it at the checkout's `dist/index.js` to check a local build. A local build check does not establish installed-artifact compatibility. Build the checkout first only when selecting its local `dist/index.js`. The ordinary test suite may skip this integration when the interpreter is missing. `test:integration` sets `AGENTLINK_REQUIRE_TAX_INTEGRATION=1`, so a missing interpreter or omitted upper entry fails instead of being reported as a skip. `AGENTLINK_TEST_TAX_REGISTRY` is optional for deliberate override compatibility checks; if explicitly set to an invalid path, the test fails. The required `test:integration:live` acceptance uses the installed noneditable wheel, real law.go.kr credentials, and current-law retrieval to verify both lecture profiles, the continuing personal-service profile, and the three bounded temporary other-personal-service types with their projected practitioner amounts. It fails clearly when the current date is outside the supported evidence window or when law retrieval, identity, version, hash, or semantic checks do not pass. The test removes its temporary data on completion and keeps any requested calculation receipt under the caller-provided scratch directory with owner-only permissions.
