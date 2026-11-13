// Required live acceptance for a fresh tax wheel installed beside the upper stdio MCP server.
// This file intentionally has no skip or mock path; the coordinator runs it once after build/install.
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OVERRIDE_KEYS = [
  "PYTHONPATH", "PYTHONHOME", "AGENTLINK_TEST_TAX_REGISTRY", "AGENTLINK_TAX_REGISTRY",
  "AGENTLINK_TAX_MCP_PYTHONPATH",
];
const ENV_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
  "AGENTLINK_CREDENTIALS_PATH",
];
const python = process.env.AGENTLINK_TEST_TAX_PYTHON;
const taskTemp = process.env.TMPDIR;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = join(root, "dist", "index.js");

class AcceptanceFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "AcceptanceFailure";
    this.stack = `AcceptanceFailure: ${message}`;
  }
}

function must(condition, message) {
  if (!condition) throw new AcceptanceFailure(message);
}

function same(actual, expected, message) {
  must(actual === expected, message);
}

function equivalent(actual, expected, message) {
  let equal = false;
  try { equal = JSON.stringify(actual) === JSON.stringify(expected); } catch { /* handled below */ }
  must(equal, message);
}

function kstDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

const CALCULATION_VALUE_FIELDS = [
  "expense_rate", "expense_amount", "income_amount", "expense_excess_amount", "tax_base", "national_rate", "national_tax",
  "local_rate", "local_tax", "total_withholding", "net_payment",
];

function assertNoCalculatedAmounts(result, paymentIds, message) {
  must(Array.isArray(result.withholding_calculations), `${message}: calculation rows are missing`);
  for (const paymentId of paymentIds) {
    const row = result.withholding_calculations.find((item) => item.payment_id === paymentId);
    must(row && row.status !== "computed", `${message}: ${paymentId} must not be computed`);
    for (const field of CALCULATION_VALUE_FIELDS) {
      same(row[field], null, `${message}: ${paymentId}.${field} must be null`);
    }
  }
}

function assertNoComputedTaxAssessments(answer, message) {
  const calculations = (answer.assessments ?? []).filter((assessment) =>
    /^tax\.wh-calc-(?:business|other|other-service|local)$/u.test(assessment.card_id ?? ""));
  must(calculations.every((assessment) => assessment.outcome !== "computed_value"),
    `${message}: practitioner output must not contain computed tax assessments`);
}

function assertTypedPaymentAssessments(answer, expected) {
  const matching = (answer.assessments ?? []).filter((assessment) => assessment.case_label === expected.paymentId);
  same(matching.length, 3, `${expected.paymentId} must have national, local, and applicability assessments`);
  const mainCard = mainCardForProfile(expected.profile);
  const national = matching.find((assessment) => assessment.card_id === mainCard &&
    assessment.outcome === "computed_value");
  const local = matching.find((assessment) => assessment.card_id === "tax.wh-calc-local" &&
    assessment.outcome === "computed_value");
  const comparison = matching.find((assessment) => assessment.card_id === mainCard &&
    assessment.outcome === expected.comparisonOutcome);
  must(national && local && comparison, `${expected.paymentId} must expose typed national/local/comparison results`);
  for (const [assessment, value, expression] of [
    [national, expected.national, expected.nationalExpression],
    [local, expected.local, expected.localExpression],
  ]) {
    same(assessment.computed?.value, value, `${expected.paymentId} computed assessment must expose the exact won amount`);
    same(assessment.computed?.unit, "won", `${expected.paymentId} computed assessment must use won units`);
    same(assessment.computed?.currency, "KRW", `${expected.paymentId} computed assessment must use KRW currency`);
    must(typeof assessment.computed?.expression === "string" && assessment.computed.expression.length > 0,
      `${expected.paymentId} computed assessment must explain its expression`);
    const expressionMatches = expression instanceof RegExp
      ? expression.test(assessment.computed.expression)
      : assessment.computed.expression === expression;
    must(expressionMatches,
      `${expected.paymentId} computed assessment must expose the expected calculation operands and rule`);
    same(assessment.reliance, "do_not_rely_verify_source", `${expected.paymentId} must remain pending source review`);
    must(assessment.notices.includes("review=pending") &&
      assessment.notices.includes("comparison_basis=national_tax_only") &&
      assessment.notices.includes("local_tax_excluded_from_actual_comparison") &&
      assessment.notices.includes(`actual_withheld_comparison=${expected.comparisonStatus}`),
    `${expected.paymentId} computed assessment must retain review and comparison limits`);
  }
  same(comparison.card_id, mainCard, `${expected.paymentId} applicability comparison must use its profile card`);
  same(comparison.outcome, expected.comparisonOutcome,
    `${expected.paymentId} applicability comparison must reflect its payment-level result`);
  same(Object.keys(comparison.computed ?? {}).length, 0,
    `${expected.paymentId} applicability comparison must not add a third numeric tax value`);
  same(comparison.reliance, "do_not_rely_verify_source", `${expected.paymentId} comparison must remain pending review`);
  must(comparison.notices.includes(`profile=${expected.profile}`) && comparison.notices.includes("review=pending"),
    `${expected.paymentId} comparison must identify its profile and pending review state`);
  if (expected.serviceSubtype) {
    for (const assessment of matching) {
      must(assessment.notices.includes(`service_subtype=${expected.serviceSubtype}`) &&
        assessment.notices.includes(`service_subtype_label=${expected.serviceSubtypeLabel}`),
      `${expected.paymentId} practitioner assessments must identify the selected service subtype`);
    }
  }
  if (expected.otherServiceSubtype) {
    for (const assessment of matching) {
      must(assessment.notices.includes(`other_service_subtype=${expected.otherServiceSubtype}`) &&
        assessment.notices.includes(`other_service_subtype_label=${expected.otherServiceSubtypeLabel}`),
      `${expected.paymentId} practitioner assessments must identify the selected other-service subtype`);
    }
  }
  if (expected.expenseMethod === "actual") {
    for (const assessment of matching) {
      must(assessment.notices.includes("expense_method=actual") &&
        assessment.notices.includes("actual_expense_scope_confirmation=user_supplied_unverified"),
      `${expected.paymentId} must label actual expenses and keep the scope assertion unverified`);
    }
  if (expected.lossScope) {
    const lossNotices = ["loss_scope=per_payment_only", "annual_other_income_netting=not_computed",
      "other_income_offset=not_computed", "loss_carryforward=not_computed", "refund=not_computed"];
    for (const assessment of matching) {
      for (const notice of lossNotices) {
        must(assessment.notices.includes(notice),
          `${expected.paymentId} practitioner assessment must include ${notice}`);
      }
    }
  }
  }
}

function mainCardForProfile(profile) {
  if (profile === "business_lecture" || profile === "business_personal_service") return "tax.wh-calc-business";
  if (profile === "other_personal_service") return "tax.wh-calc-other-service";
  return "tax.wh-calc-other";
}

function decodedCalculationSection(answer, paymentId, profile) {
  const mainCard = mainCardForProfile(profile);
  const rows = answer.perspective_view?.sections?.withholding_calculations ?? [];
  const matching = rows.filter((item) => item.card_id === mainCard && typeof item.text === "string" &&
    item.text.split(/\r?\n/u).includes(`지급 ID: ${paymentId}`));
  same(matching.length, 1, `${paymentId} must have one practitioner calculation section`);
  return matching[0];
}

function assertPractitionerCalculationSection(answer, expected) {
  const entry = decodedCalculationSection(answer, expected.paymentId, expected.profile);
  const lines = entry.text.split(/\r?\n/u);
  const includes = (line) => must(lines.includes(line),
    `${expected.paymentId} practitioner calculation section must include ${line.split(":")[0]}`);
  same(entry.card_id, mainCardForProfile(expected.profile),
    `${expected.paymentId} practitioner calculation section must use the profile card`);
  includes(`프로필: ${expected.profile}`);
  if (expected.serviceSubtype) includes(`용역 세부유형: ${expected.serviceSubtype} (${expected.serviceSubtypeLabel})`);
  if (expected.otherServiceSubtype) {
    must(entry.text.includes(`${expected.otherServiceSubtype} (${expected.otherServiceSubtypeLabel})`),
      `${expected.paymentId} practitioner calculation section must identify its other-service subtype`);
  }
  includes(`행 상태: computed; 적용성: ${expected.applicability}`);
  includes(`총수입금액: ${expected.values.gross_amount}원`);
  if (expected.expenseMethod === "actual") {
    must(lines.some((line) => line.startsWith("필요경비 방식: 실제 필요경비")),
      `${expected.paymentId} practitioner calculation section must label the actual expense method`);
    must(lines.some((line) => line.includes(String(expected.values.expense_amount)) && line.includes("실제")),
      `${expected.paymentId} practitioner calculation section must show the supplied actual expense total`);
    includes("사용자 확인 실제 필요경비 범위(미검증): true");
    if (expected.lossScope) {
      includes(`지급 건별 기타소득 차액(연간 소득금액 아님): ${expected.values.gross_amount} − ${expected.values.expense_amount} = ${expected.values.income_amount}원`);
      must(lines.some((line) => line.startsWith("지급액 초과 필요경비:") &&
        line.includes(String(expected.expenseExcessAmount))),
      `${expected.paymentId} practitioner section must report the positive expense excess`);
      includes(`원천징수 계산용 과세표준: ${expected.values.tax_base}원`);
    } else {
      includes(`기타소득금액: ${expected.values.gross_amount} − ${expected.values.expense_amount} = ${expected.values.income_amount}원`);
      includes(`과세표준(1원 미만 절사): ${expected.values.tax_base}원`);
    }
  } else if (expected.values.expense_rate !== null && expected.values.expense_rate !== undefined) {
    includes(`표준 필요경비: ${expected.values.gross_amount} × ${expected.values.expense_rate} = ${expected.values.expense_amount}원`);
    const incomeLabel = expected.profile === "other_lecture" || expected.profile === "other_personal_service"
      ? "기타소득금액" : "소득금액";
    includes(`${incomeLabel}: ${expected.values.gross_amount} − ${expected.values.expense_amount} = ${expected.values.income_amount}원`);
    includes(`과세표준(1원 미만 절사): ${expected.values.tax_base}원`);
  } else {
    includes(`사업소득금액: ${expected.values.income_amount}원`);
    includes(`과세표준: ${expected.values.tax_base}원`);
  }
  includes(`국세율: ${expected.nationalRate}; 국세: ${expected.formula}`);
  includes(`국세 원천징수 후보: ${expected.national}원`);
  includes(`지방소득세율: ${expected.localRate}; 지방소득세: 10원 단위 절사(${expected.national} × ${expected.localRate}) = ${expected.local}원`);
  includes(`총 원천징수 후보: ${expected.national} + ${expected.local} = ${expected.total}원`);
  includes(`순지급액: ${expected.values.gross_amount} − ${expected.total} = ${expected.net}원`);
  includes(`실제 징수액 대조(국세만, 지방소득세 제외): ${expected.comparisonStatus}; 사용자 입력 실제 징수액: ${expected.actualWithheld}`);
  must(lines.some((line) => line.startsWith("반올림·절사 정책: ")),
    `${expected.paymentId} practitioner calculation section must retain rounding policy`);
}

function assertPractitionerBasisProjection(answer, planResult, paymentIds = null) {
  const projected = answer.perspective_view?.sections?.withholding_basis_checks ?? [];
  const expectedMarkers = [];
  const selectedPaymentIds = paymentIds === null ? null : new Set(paymentIds);
  for (const row of planResult.withholding_calculations.filter((item) => item.status === "computed" &&
    (selectedPaymentIds === null || selectedPaymentIds.has(item.payment_id)))) {
    for (const check of row.basis_checks) {
      const cardId = `tax.${check.rule_id.toLowerCase()}`;
      const instrumentId = INSTRUMENT_BY_LAW_ID[check.law_id];
      must(instrumentId, `Practitioner basis projection received an unpinned legal instrument for ${check.rule_id}`);
      const prefix = `지급 ID: ${row.payment_id}; 규칙: ${check.rule_id}; 법령 instrument ID: ${instrumentId}; 법령 ID: ${check.law_id}; 조문: ${check.article}; 정확한 위치: ${check.locator}; 상태: ${check.status};`;
      must(projected.filter((item) => item.card_id === cardId && typeof item.text === "string" &&
        item.text.startsWith(prefix)).length === 1,
      `Practitioner basis section must preserve ${check.rule_id} ${check.article} ${check.locator}`);
      expectedMarkers.push(prefix);
    }
  }
  same(projected.length, expectedMarkers.length,
    "Practitioner basis cards must not omit or add source clauses beyond the computed payments");
}

function assertComputedRow(result, paymentId, expected) {
  const row = result.withholding_calculations?.find((item) => item.payment_id === paymentId);
  must(row, `Calculation row is missing for ${paymentId}`);
  same(row.profile, expected.profile, `${paymentId} must retain its selected profile`);
  if (expected.serviceSubtype) same(row.service_subtype, expected.serviceSubtype,
    `${paymentId} must echo the selected service subtype`);
  if (expected.otherServiceSubtype) same(row.other_service_subtype, expected.otherServiceSubtype,
    `${paymentId} must echo the selected other-service subtype`);
  same(row.status, "computed", `${paymentId} must have a calculation result`);
  const expectedExpenseMethod = expected.expenseMethod ??
    (expected.profile === "other_lecture" || expected.profile === "other_personal_service" ? "standard_60" : null);
  same(row.expense_method ?? null, expectedExpenseMethod,
    `${paymentId} must retain the selected expense method`);
  same(row.applicability_status, expected.applicability, `${paymentId} applicability must match the expected scope`);
  for (const [field, value] of Object.entries(expected.values)) {
    same(row[field], value, `${paymentId}.${field} must match the independent expected result`);
  }
  const otherProfile = expected.profile === "other_lecture" || expected.profile === "other_personal_service";
  const expectedExpenseExcess = expected.expenseExcessAmount ?? (otherProfile ? "0" : null);
  same(row.expense_excess_amount, expectedExpenseExcess,
    `${paymentId}.expense_excess_amount must remain an unsigned amount or null outside OTHER calculations`);
  if (expected.lossScope) {
    must(row.reason_codes.includes("below_taxable_minimum") &&
      row.reason_codes.includes("actual_expenses_exceed_gross"),
    `${paymentId} loss row must carry the below-minimum and excess-expense reason markers`);
  } else {
    must(!row.reason_codes.includes("actual_expenses_exceed_gross"),
      `${paymentId} must not be marked as an above-gross expense row`);
  }
  must(typeof row.formula === "string" && row.formula.length > 0, `${paymentId} must explain its formula`);
  same(row.rounding, "truncate_national_tax_to_10_won_then_local_tax_to_10_won",
    `${paymentId} must report the two-stage won truncation convention`);
  same(row.fact_verification, "user_supplied_unverified", `${paymentId} facts must remain unverified`);
  same(row.review, "pending", `${paymentId} must remain pending review`);
  must(Array.isArray(row.basis_checks) && row.basis_checks.length > 0, `${paymentId} must include calculation basis checks`);
  return row;
}

const SHARED_REQUIRED_BASIS = [
  { rule_id: "WH-CALC-NATIONAL-ROUND", law_id: "009409", article: "제47조",
    locator: "제47조 제1항·제2항", semantics: [
      { locator: "제47조 제1항", pattern: /(?=.*국고금의\s*수입\s*또는\s*지출)(?=.*10\s*원\s*미만의\s*끝수가.*그\s*끝수는\s*계산하지\s*아니하고)(?=.*전액이\s*10\s*원\s*미만.*전액을\s*계산하지\s*아니한다)(?=.*대통령령으로\s*정하는\s*경우)/u },
      { locator: "제47조 제2항", pattern: /국세의\s*과세표준액을\s*산정할\s*때.*1\s*원\s*미만의\s*끝수가\s*있으면\s*이를\s*계산하지\s*아니한다/u },
    ] },
  { rule_id: "WH-CALC-NATIONAL-ROUND-EXCEPTION", law_id: "009450", article: "제109조의2",
    locator: "제109조의2 제1항", semantics: [{ locator: "제109조의2 제1항", pattern: /법\s*제47조제1항\s*단서에서.*국고금을\s*분할하여\s*징수\s*또는\s*수납하거나\s*지급할\s*때.*분할금액\s*또는\s*끝수를.*최초의\s*수입금\s*또는\s*지급금에\s*합산/u }] },
  { rule_id: "WH-CALC-LOCAL", law_id: "001649", article: "제103조의13",
    locator: "제103조의13 제1항·제4항", semantics: [
      { locator: "제103조의13 제1항", pattern: /원천징수의무자가\s*거주자로부터\s*소득세를\s*원천징수.*원천징수하는\s*소득세.*100\s*분의\s*10.*소득세\s*원천징수와\s*동시에\s*개인지방소득세로\s*특별징수하여야/u },
      { locator: "제103조의13 제4항", pattern: /개인지방소득세의\s*특별징수에\s*관하여.*이\s*법에\s*특별한\s*규정이\s*있는\s*경우를\s*제외하고는.*(?:「)?소득세법(?:」)?에\s*따른\s*원천징수에\s*관한\s*규정을\s*준용/u },
    ] },
  { rule_id: "WH-CALC-LOCAL-ROUND", law_id: "012559", article: "제55조",
    locator: "제55조", semantics: [{ locator: "제55조", pattern: /지방자치단체의\s*수입\s*또는\s*지출에서\s*10\s*원\s*미만은\s*계산하지\s*아니할\s*수.*전액이\s*10\s*원\s*미만이면\s*0으로\s*처리할\s*수.*세입금을\s*분할하여\s*징수/u }] },
  { rule_id: "WH-CALC-LOCAL-ROUND-EXCEPTION", law_id: "012678", article: "제67조",
    locator: "제67조", semantics: [{ locator: "제67조", pattern: /법\s*제55조\s*단서에서.*세입금을\s*분할하여\s*징수.*분할금액\s*또는\s*끝수를.*최초의\s*수입금\s*또는\s*지급금에\s*합산/u }] },
];

const BUSINESS_REQUIRED_BASIS = [
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제19조", locator: "제19조 제1항 제21호",
    semantics: [{ locator: "제19조 제1항 제21호", pattern: /(?=.*영리를\s*목적으로)(?=.*자기의\s*계산과\s*책임\s*하에)(?=.*계속적[ㆍ·]?\s*반복적으로\s*행하는\s*활동)/u }] },
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제127조", locator: "제127조 제1항 제3호·제6호",
    semantics: [
      { locator: "제127조 제1항 제3호", pattern: /대통령령으로\s*정하는\s*사업소득.*원천징수대상\s*사업소득/u },
      { locator: "제127조 제1항 제6호", pattern: /기타소득.*다음\s*각\s*목의\s*어느\s*하나에\s*해당하는\s*소득은\s*제외/u },
    ] },
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제129조", locator: "제129조 제1항 제3호·제6호 라목",
    semantics: [
      { locator: "제129조 제1항 제3호", pattern: /원천징수대상\s*사업소득에\s*대해서는\s*100\s*분의\s*3/u },
      { locator: "제129조 제1항 제6호 라목", pattern: /그\s*밖의\s*기타소득에\s*대해서는\s*100\s*분의\s*20/u },
    ] },
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제144조", locator: "제144조 제1항",
    semantics: [{ locator: "제144조 제1항", pattern: /원천징수의무자가\s*원천징수대상\s*사업소득을\s*지급할\s*때.*지급금액에\s*원천징수세율을\s*적용하여\s*계산한\s*소득세를\s*원천징수/u }] },
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제86조", locator: "제86조 제1호",
    semantics: [{ locator: "제86조 제1호", pattern: /(?=.*제127조제1항\s*각\s*호의\s*소득)(?=.*제3호의\s*원천징수대상\s*사업소득\s*중\s*대통령령으로\s*정하는\s*사업소득은\s*제외한다)(?=.*원천징수세액이\s*1천원\s*미만인\s*경우)/u }] },
  { rule_id: "WH-CALC-BUSINESS-SCOPE", law_id: "003956", article: "제184조", locator: "제184조 제1항·제3항",
    semantics: [
      { locator: "제184조 제1항", pattern: /법\s*제127조제1항제3호에서.*대통령령으로\s*정하는\s*사업소득["”]?\s*이란.*제26조제1항제5호\s*및\s*제15호에\s*따른\s*용역의\s*공급에서\s*발생하는\s*소득/u },
      { locator: "제184조 제3항", pattern: /(?=.*소득세를\s*원천징수하여야\s*할\s*자는)(?=.*사업자)(?=.*법인세의\s*납세의무자)/u },
    ] },
  { rule_id: "WH-CALC-BUSINESS-SCOPE", law_id: "003956", article: "제149조의3", locator: "제149조의3",
    semantics: [{ locator: "제149조의3", pattern: /(?=.*법\s*제86조제1호에서)(?=.*대통령령으로\s*정하는\s*사업소득["”]?\s*이란)(?=.*제26조제1항제15호에\s*따른\s*인적\s*용역을)(?=.*계속적[ㆍ·]?\s*반복적으로\s*공급하고)(?=.*그\s*대가로\s*받은\s*소득)/u }] },
  { rule_id: "WH-CALC-BUSINESS-VAT", law_id: "001571", article: "제26조", locator: "제26조 제1항 제15호",
    semantics: [{ locator: "제26조 제1항 제15호", pattern: /저술가.*작곡가나\s*그\s*밖의\s*자가\s*직업상\s*제공하는\s*인적\s*\(\s*人的\s*\)\s*용역으로서\s*대통령령으로\s*정하는\s*것/u }] },
  { rule_id: "WH-CALC-BUSINESS-SERVICE", law_id: "003666", article: "제42조",
    locator: "제42조 제1호 본문 및 제1호 차목", semantics: [
      { locator: "제42조 제1호 본문", pattern: /(?=.*개인이)(?=.*물적\s*시설\s*없이)(?=.*근로자를\s*고용.*하지\s*아니하고)(?=.*고용\s*외의\s*형태.*주된\s*업무.*타인으로부터\s*노무\s*등을\s*제공받는\s*경우를\s*포함)(?=.*독립된\s*자격으로\s*용역을\s*공급하고\s*대가를\s*받는)/u },
      { locator: "제42조 제1호 차목", pattern: /고용관계\s*없는\s*사람이\s*다수인에게\s*강연을\s*하고\s*강연료.*대가를\s*받는\s*용역/u },
    ] },
  { rule_id: "WH-CALC-BUSINESS-FACILITIES", law_id: "007289", article: "제29조", locator: "제29조",
    semantics: [{ locator: "제29조", pattern: /영\s*제42조제1호에서.*물적\s*시설.*이란.*계속적[ㆍ·]?\s*반복적으로\s*사업에만\s*이용되는.*건축물.*기계장치.*사업설비/u }] },
  ...SHARED_REQUIRED_BASIS,
];

const OTHER_REQUIRED_BASIS = [
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제21조", locator: "제21조 제1항 제19호 가목·제3항",
    semantics: [
      { locator: "제21조 제1항 제19호 가목", pattern: /고용관계\s*없이\s*다수인에게\s*강연을\s*하고\s*강연료.*대가를\s*받는\s*용역/u },
      { locator: "제21조 제3항", pattern: /기타소득금액은\s*해당\s*과세기간의\s*총수입금액에서\s*이에\s*사용된\s*필요경비를\s*공제한\s*금액/u },
    ] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제127조", locator: "제127조 제1항 제3호·제6호",
    semantics: [
      { locator: "제127조 제1항 제3호", pattern: /대통령령으로\s*정하는\s*사업소득.*원천징수대상\s*사업소득/u },
      { locator: "제127조 제1항 제6호", pattern: /기타소득.*다음\s*각\s*목의\s*어느\s*하나에\s*해당하는\s*소득은\s*제외/u },
    ] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제129조", locator: "제129조 제1항 제3호·제6호 라목",
    semantics: [
      { locator: "제129조 제1항 제3호", pattern: /원천징수대상\s*사업소득에\s*대해서는\s*100\s*분의\s*3/u },
      { locator: "제129조 제1항 제6호 라목", pattern: /그\s*밖의\s*기타소득에\s*대해서는\s*100\s*분의\s*20/u },
    ] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제145조", locator: "제145조 제1항",
    semantics: [{ locator: "제145조 제1항", pattern: /원천징수의무자가\s*기타소득을\s*지급할\s*때.*기타소득금액에\s*원천징수세율을\s*적용하여\s*계산한\s*소득세를\s*원천징수/u }] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제84조", locator: "제84조 제4호",
    semantics: [{ locator: "제84조 제4호", pattern: /그\s*밖의\s*기타소득금액.*제21조제1항제21호의\s*기타소득금액은\s*제외.*건별로\s*5만원\s*이하인\s*경우/u }] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제37조", locator: "제37조 제2항",
    semantics: [{ locator: "제37조 제2항", pattern: /총수입금액에\s*대응하는\s*비용으로서\s*일반적으로\s*용인되는\s*통상적인\s*것의\s*합계액을\s*필요경비에\s*산입/u }] },
  { rule_id: "WH-CALC-OTHER-EXPENSE", law_id: "003956", article: "제87조", locator: "제87조 제1호의2",
    semantics: [{ locator: "제87조 제1호의2", pattern: /(?=.*법\s*제21조제1항.*제15호\s*및\s*제19호의\s*기타소득)(?=.*거주자가\s*받은\s*금액의\s*100\s*분의\s*60에\s*상당하는\s*금액을\s*필요경비로\s*한다)(?=.*다만.*실제\s*소요된\s*필요경비가\s*거주자가\s*받은\s*금액의\s*100\s*분의\s*60에\s*상당하는\s*금액을\s*초과하면.*그\s*초과하는\s*금액도\s*필요경비에\s*산입)/u }] },
];

const OTHER_ACTUAL_EXPENSE_BASIS = [
  { rule_id: "WH-CALC-OTHER-ACTUAL-SCOPE", law_id: "001565", article: "제37조",
    locator: "제37조 제2항·제4항", semantics: [
      { locator: "제37조 제2항", pattern: /(?=.*해당\s*과세기간의\s*총수입금액에\s*대응하는\s*비용)(?=.*일반적으로\s*용인되는\s*통상적인\s*것의\s*합계액)(?=.*필요경비에\s*산입)/u },
      { locator: "제37조 제4항", pattern: /(?=.*기타소득금액을\s*계산할\s*때)(?=.*필요경비에\s*산입하지\s*아니하는\s*금액)(?=.*제33조를\s*준용)/u },
    ] },
  { rule_id: "WH-CALC-OTHER-ACTUAL-SCOPE", law_id: "001565", article: "제33조",
    locator: "제33조 제1항", semantics: [{ locator: "제33조 제1항",
      pattern: /(?=.*소득세)(?=.*개인지방소득세)(?=.*벌금)(?=.*과료)(?=.*과태료)(?=.*가사)/u }] },
  { rule_id: "WH-CALC-OTHER-ACTUAL-WITHHOLDING", law_id: "003956", article: "제202조",
    locator: "제202조 제1항", semantics: [{ locator: "제202조 제1항",
      pattern: /(?=.*지급금액에서\s*이에\s*대응하는\s*필요경비)(?=.*원천징수의무자가\s*확인할\s*수\s*있는\s*금액)(?=.*제87조의\s*규정에\s*의한\s*필요경비)/u }] },
];

const OTHER_LOSS_SCOPE_BASIS = [
  { rule_id: "WH-CALC-OTHER-LOSS-SCOPE", law_id: "001565", article: "제21조",
    locator: "제21조 제3항", semantics: [{ locator: "제21조 제3항",
      pattern: /기타소득금액은\s*해당\s*과세기간의\s*총수입금액에서\s*이에\s*사용된\s*필요경비를\s*공제한\s*금액/u }] },
  { rule_id: "WH-CALC-OTHER-LOSS-SCOPE", law_id: "001565", article: "제45조",
    locator: "제45조 제1항·제3항", semantics: [
      { locator: "제45조 제1항", pattern: /사업자가\s*비치[ㆍ·]기록한\s*장부에\s*의하여.*사업소득금액을\s*계산할\s*때\s*발생한\s*결손금.*종합소득과세표준.*기타소득금액.*에서\s*순서대로\s*공제/u },
      { locator: "제45조 제3항", pattern: /부동산임대업에서\s*발생한\s*결손금.*제1항 및 제2항 단서에 따라 공제하고 남은 결손금.*이월결손금.*15년.*소득금액을\s*계산할\s*때/u },
    ] },
];

const OTHER_PERSONAL_SERVICE_MAIN_BASIS = [
  { rule_id: "WH-CALC-OTHER-SERVICE", law_id: "001565", article: "제21조", locator: "제21조 제3항",
    semantics: [{ locator: "제21조 제3항", pattern: /기타소득금액은\s*해당\s*과세기간의\s*총수입금액에서\s*이에\s*사용된\s*필요경비를\s*공제한\s*금액/u }] },
  ...OTHER_REQUIRED_BASIS.slice(1, 6).map((spec) => ({ ...spec, rule_id: "WH-CALC-OTHER-SERVICE" })),
];

const OTHER_PERSONAL_SERVICE_SCOPE_BASIS = {
  manuscript_fee: { rule_id: "WH-CALC-OTHER-MANUSCRIPT", law_id: "001565", article: "제21조",
    locator: "제21조 제1항 본문 및 제1항 제15호 본문 및 제1항 제15호 가목", semantics: [
      { locator: "제21조 제1항 본문", pattern: /(?=.*이자소득)(?=.*배당소득)(?=.*사업소득)(?=.*근로소득)(?=.*연금소득)(?=.*퇴직소득)(?=.*양도소득\s*외의\s*소득)/u },
      { locator: "제21조 제1항 제15호 본문", pattern: /(?=.*문예)(?=.*학술)(?=.*미술)(?=.*음악)(?=.*사진)(?=.*창작품)(?=.*원작자로서\s*받는\s*소득)/u },
      { locator: "제21조 제1항 제15호 가목", pattern: /원고료/u },
    ] },
  expert_advisory: { rule_id: "WH-CALC-OTHER-ADVISORY", law_id: "001565", article: "제21조",
    locator: "제21조 제1항 본문 및 제1항 제19호 본문 및 제1항 제19호 다목", semantics: [
      { locator: "제21조 제1항 본문", pattern: /(?=.*이자소득)(?=.*배당소득)(?=.*사업소득)(?=.*근로소득)(?=.*연금소득)(?=.*퇴직소득)(?=.*양도소득\s*외의\s*소득)/u },
      { locator: "제21조 제1항 제19호 본문", pattern: /(?=.*제15호부터\s*제17호까지.*제외)(?=.*일시적으로\s*제공하고\s*받는\s*대가)/u },
      { locator: "제21조 제1항 제19호 다목", pattern: /(?=.*전문적\s*지식\s*또는\s*특별한\s*기능을\s*가진\s*자)(?=.*그\s*지식\s*또는\s*기능을\s*활용하여)(?=.*보수\s*또는\s*그\s*밖의\s*대가를\s*받고\s*제공하는\s*용역)/u },
    ] },
  broadcast_commentary: { rule_id: "WH-CALC-OTHER-BROADCAST", law_id: "001565", article: "제21조",
    locator: "제21조 제1항 본문 및 제1항 제19호 본문 및 제1항 제19호 나목", semantics: [
      { locator: "제21조 제1항 본문", pattern: /(?=.*이자소득)(?=.*배당소득)(?=.*사업소득)(?=.*근로소득)(?=.*연금소득)(?=.*퇴직소득)(?=.*양도소득\s*외의\s*소득)/u },
      { locator: "제21조 제1항 제19호 본문", pattern: /(?=.*제15호부터\s*제17호까지.*제외)(?=.*일시적으로\s*제공하고\s*받는\s*대가)/u },
      { locator: "제21조 제1항 제19호 나목", pattern: /(?=.*라디오[ㆍ·]?텔레비전방송\s*등을\s*통하여)(?=.*해설[ㆍ·]계몽\s*또는\s*연기의\s*심사\s*등을)(?=.*보수\s*또는\s*이와\s*유사한\s*성질의\s*대가)/u },
    ] },
};

const PERSONAL_SERVICE_GROUP_BASIS = {
  creative: { rule_id: "WH-CALC-PERSONAL-CREATIVE", law_id: "003666", article: "제42조",
    locator: "제42조 제1호 본문 및 제1호 가목", semantics: [
      { locator: "제42조 제1호 본문", pattern: /(?=.*개인이)(?=.*물적\s*시설\s*없이)(?=.*근로자를\s*고용.*하지\s*아니하고)(?=.*고용\s*외의\s*형태.*주된\s*업무.*타인으로부터\s*노무\s*등을\s*제공받는\s*경우를\s*포함)(?=.*독립된\s*자격으로\s*용역을\s*공급하고\s*대가를\s*받는)/u },
      { locator: "제42조 제1호 가목", pattern: /(?=.*저술)(?=.*도안)(?=.*삽화)(?=.*작곡)(?=.*성우)/u },
    ] },
  entertainment: { rule_id: "WH-CALC-PERSONAL-ENTERTAINMENT", law_id: "003666", article: "제42조",
    locator: "제42조 제1호 본문 및 제1호 나목", semantics: [
      { locator: "제42조 제1호 본문", pattern: /(?=.*개인이)(?=.*물적\s*시설\s*없이)(?=.*근로자를\s*고용.*하지\s*아니하고)(?=.*고용\s*외의\s*형태.*주된\s*업무.*타인으로부터\s*노무\s*등을\s*제공받는\s*경우를\s*포함)(?=.*독립된\s*자격으로\s*용역을\s*공급하고\s*대가를\s*받는)/u },
      { locator: "제42조 제1호 나목", pattern: /(?=.*연예에\s*관한)(?=.*연출)(?=.*촬영)/u },
    ] },
  language: { rule_id: "WH-CALC-PERSONAL-LANGUAGE", law_id: "003666", article: "제42조",
    locator: "제42조 제1호 본문 및 제1호 자목", semantics: [
      { locator: "제42조 제1호 본문", pattern: /(?=.*개인이)(?=.*물적\s*시설\s*없이)(?=.*근로자를\s*고용.*하지\s*아니하고)(?=.*고용\s*외의\s*형태.*주된\s*업무.*타인으로부터\s*노무\s*등을\s*제공받는\s*경우를\s*포함)(?=.*독립된\s*자격으로\s*용역을\s*공급하고\s*대가를\s*받는)/u },
      { locator: "제42조 제1호 자목", pattern: /(?=.*교정)(?=.*번역)(?=.*속기)/u },
    ] },
};

const PERSONAL_SERVICE_SUBTYPES = {
  authorship: { label: "저술 용역", group: "creative" },
  artwork_design: { label: "도안 용역", group: "creative" },
  illustration: { label: "삽화 용역", group: "creative" },
  composition: { label: "작곡 용역", group: "creative" },
  voice_acting: { label: "성우 용역", group: "creative" },
  entertainment_direction: { label: "연예에 관한 연출 용역", group: "entertainment" },
  entertainment_filming: { label: "연예에 관한 촬영 용역", group: "entertainment" },
  proofreading: { label: "교정 용역", group: "language" },
  translation: { label: "번역 용역", group: "language" },
  shorthand: { label: "속기 용역", group: "language" },
};

const OTHER_PERSONAL_SERVICE_SUBTYPES = {
  manuscript_fee: { label: "원작자의 창작 원고료", rule_id: "WH-CALC-OTHER-MANUSCRIPT" },
  expert_advisory: { label: "전문지식·특별기능을 활용한 일시적 자문료", rule_id: "WH-CALC-OTHER-ADVISORY" },
  broadcast_commentary: { label: "방송 등을 통한 일시적 해설·계몽·연기 심사료", rule_id: "WH-CALC-OTHER-BROADCAST" },
};

const PERSONAL_SERVICE_SHARED_BASIS = BUSINESS_REQUIRED_BASIS.filter((spec) =>
  spec.rule_id !== "WH-CALC-BUSINESS-SERVICE");

const INSTRUMENT_BY_LAW_ID = {
  "001565": "income-tax-act",
  "003956": "income-tax-decree",
  "001571": "vat-act",
  "003666": "vat-decree",
  "007289": "vat-rule",
  "009409": "national-funds-act",
  "009450": "national-funds-decree",
  "001649": "local-tax-act",
  "012559": "local-accounting-act",
  "012678": "local-accounting-decree",
};

function decimalParts(value) {
  const text = typeof value === "number" && Number.isFinite(value)
    ? String(value) : typeof value === "string" ? value : "";
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { coefficient: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function decimalGreaterThan(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b) return false;
  const scale = Math.max(a.scale, b.scale);
  return a.coefficient * 10n ** BigInt(scale - a.scale) >
    b.coefficient * 10n ** BigInt(scale - b.scale);
}

function expectsOtherLossScope(paymentInput) {
  if (!paymentInput || !["other_lecture", "other_personal_service"].includes(paymentInput.withholding_profile) ||
      paymentInput.expenses_exceed_standard !== true || paymentInput.actual_expense_amount === undefined ||
      paymentInput.actual_expense_amount === null || paymentInput.gross_amount === undefined ||
      paymentInput.gross_amount === null) return false;
  if (paymentInput.withholding_profile === "other_personal_service" &&
      !Object.hasOwn(OTHER_PERSONAL_SERVICE_SUBTYPES, paymentInput.other_service_subtype)) return false;
  return decimalGreaterThan(paymentInput.actual_expense_amount, paymentInput.gross_amount);
}

function specsForProfile(profile, serviceSubtype, otherServiceSubtype,
                         expenseMethod = "standard_60", lossScopeExpected = false) {
  if (profile === "business_lecture") return BUSINESS_REQUIRED_BASIS;
  if (profile === "other_lecture") return [
    ...OTHER_REQUIRED_BASIS,
    ...(expenseMethod === "actual" ? OTHER_ACTUAL_EXPENSE_BASIS : []),
    ...(lossScopeExpected ? OTHER_LOSS_SCOPE_BASIS : []),
    ...SHARED_REQUIRED_BASIS,
  ];
  if (profile === "business_personal_service") {
    const selected = PERSONAL_SERVICE_SUBTYPES[serviceSubtype];
    if (!selected) throw new AcceptanceFailure("A supported personal-service subtype is required for a basis assertion");
    return [...PERSONAL_SERVICE_SHARED_BASIS, PERSONAL_SERVICE_GROUP_BASIS[selected.group]];
  }
  if (profile === "other_personal_service") {
    const selected = OTHER_PERSONAL_SERVICE_SUBTYPES[otherServiceSubtype];
    const scopeBasis = OTHER_PERSONAL_SERVICE_SCOPE_BASIS[otherServiceSubtype];
    if (!selected || !scopeBasis) {
      throw new AcceptanceFailure("A supported other-personal-service subtype is required for a basis assertion");
    }
    return [...OTHER_PERSONAL_SERVICE_MAIN_BASIS, scopeBasis, ...OTHER_REQUIRED_BASIS.slice(6),
      ...(expenseMethod === "actual" ? OTHER_ACTUAL_EXPENSE_BASIS : []),
      ...(lossScopeExpected ? OTHER_LOSS_SCOPE_BASIS : []), ...SHARED_REQUIRED_BASIS];
  }
  throw new AcceptanceFailure("A supported withholding profile is required for a basis assertion");
}

function basisKey(row) {
  return [row.rule_id, row.law_id, row.article, row.locator].join("|");
}

test("loss-scope basis selection requires trusted positive-excess input facts", () => {
  const lossInput = {
    withholding_profile: "other_lecture", expenses_exceed_standard: true,
    actual_expense_amount: 1_200_000, gross_amount: 1_000_000,
  };
  must(expectsOtherLossScope(lossInput), "A supported actual OTHER input above gross must select loss-scope evidence");
  const selected = specsForProfile("other_lecture", undefined, undefined, "actual",
    expectsOtherLossScope(lossInput));
  same(selected.filter((spec) => spec.rule_id === "WH-CALC-OTHER-LOSS-SCOPE").length, 2,
    "The conditional loss card must require both Article 21(3) and Article 45(1),(3)");
  const missingScope = { ...lossInput, actual_expense_scope_confirmed: undefined };
  must(expectsOtherLossScope(missingScope),
    "Known positive excess selects its evidence even while scope confirmation is missing");
  const noLossInput = { ...lossInput, actual_expense_amount: 700_000,
    income_amount: "-200000", expense_excess_amount: "200000" };
  must(!expectsOtherLossScope(noLossInput),
    "A signed or excess-looking output value must not select evidence when trusted input is nonloss");
  must(!expectsOtherLossScope({ ...lossInput, expenses_exceed_standard: false }),
    "An unselected actual-expense method must not select loss-scope evidence");
  must(!expectsOtherLossScope({ ...lossInput, actual_expense_amount: undefined }),
    "A missing trusted actual-expense amount must not select loss-scope evidence");
  must(!expectsOtherLossScope({ ...lossInput, gross_amount: undefined }),
    "A missing trusted gross amount must not select loss-scope evidence");
  must(!expectsOtherLossScope({ ...lossInput, withholding_profile: "business_lecture" }),
    "Business profiles must not select OTHER loss-scope evidence");
});

const CIRCLED_NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
  "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
const KOREAN_SUBITEMS = "가나다라마바사아자차카타파하";

function segmentFromMarker(text, markerIndex, markerLength, nextMarkerPattern) {
  let end = text.length;
  if (nextMarkerPattern) {
    nextMarkerPattern.lastIndex = markerIndex + markerLength;
    const next = nextMarkerPattern.exec(text);
    if (next) end = next.index;
  }
  return text.slice(markerIndex, end).trim();
}

function paragraphSegment(text, number) {
  const circled = CIRCLED_NUMBERS[number - 1];
  if (circled) {
    const index = text.indexOf(circled);
    if (index >= 0) return segmentFromMarker(text, index, circled.length, /[①-⑳]/gu);
  }
  const marker = new RegExp(`제\\s*${number}\\s*항`, "u");
  const match = marker.exec(text);
  if (!match) return "";
  return segmentFromMarker(text, match.index, match[0].length, /제\s*\d+\s*항/gu);
}

function itemSegment(text, number) {
  const match = String(number).match(/^(\d+)(?:의(\d+))?$/u);
  if (!match) return "";
  const [, major, minor] = match;
  const linePrefix = "(?:^|\\r?\\n)[\\t ]*";
  const digitPattern = minor
    ? new RegExp(`${linePrefix}(${major}\\s*의\\s*${minor}\\s*[.)])`, "gu")
    : new RegExp(`${linePrefix}(${major}\\s*[.)])`, "gu");
  const explicitPattern = minor
    ? new RegExp(`${linePrefix}(제\\s*${major}\\s*호\\s*의\\s*${minor})(?=\\s|$)`, "gu")
    : new RegExp(`${linePrefix}(제\\s*${major}\\s*호)(?=\\s|$)`, "gu");
  const candidates = [digitPattern, explicitPattern];
  let found;
  for (const pattern of candidates) {
    found = pattern.exec(text);
    if (found) break;
  }
  if (!found) return "";
  const markerText = found[1];
  const start = found.index + found[0].length - markerText.length;
  const nextPattern = /(?:^|\r?\n)[\t ]*(?:\d+(?:\s*의\s*\d+)?\s*[.)]|제\s*\d+\s*호(?:\s*의\s*\d+)?(?=\s|$))/gu;
  return segmentFromMarker(text, start, markerText.length, nextPattern);
}

function subitemSegment(text, letter) {
  const marker = new RegExp(`(?:^|\\r?\\n)[\\t ]*((?:${letter}\\s*[.)]|${letter}목(?=\\s|$)))`, "gu");
  const match = marker.exec(text);
  if (!match) return "";
  const markerText = match[1];
  const start = match.index + match[0].length - markerText.length;
  const letterIndex = KOREAN_SUBITEMS.indexOf(letter);
  const nextLetters = letterIndex >= 0 ? KOREAN_SUBITEMS.slice(letterIndex + 1) : "";
  const nextPattern = nextLetters.length
    ? new RegExp(`(?:^|\\r?\\n)[\\t ]*(?:[${nextLetters}]\\s*[.)]|[${nextLetters}]목(?=\\s|$))`, "gu")
    : null;
  return segmentFromMarker(text, start, markerText.length, nextPattern);
}

function locatorSegments(text, locator) {
  const body = locator.replace(/^제\d+조(?:의\d+)?\s*/u, "");
  if (!body.trim()) return text.trim() ? [text.trim()] : [];
  const parts = body.split(/\s*[·,]\s*|\s+및\s+/u).filter(Boolean);
  let inheritedParagraph;
  const segments = [];
  for (const part of parts) {
    const paragraphMatch = part.match(/제(\d+)항/u);
    if (paragraphMatch) inheritedParagraph = Number(paragraphMatch[1]);
    let segment = inheritedParagraph === undefined ? text : paragraphSegment(text, inheritedParagraph);
    if (!segment) return [];
    const itemNumbers = [...part.matchAll(/제(\d+)호(?:의(\d+))?/gu)]
      .map((match) => `${match[1]}${match[2] ? `의${match[2]}` : ""}`);
    if (/본문/u.test(part)) {
      if (itemNumbers.length > 0) {
        for (const number of itemNumbers) {
          segment = itemSegment(segment, number);
          if (!segment) return [];
        }
        const firstSubitem = new RegExp(`(?:^|\\r?\\n)[\\t ]*[${KOREAN_SUBITEMS}](?:[\\t ]*[.)]|목(?=\\s|$))`, "u").exec(segment);
        if (firstSubitem) segment = segment.slice(0, firstSubitem.index).trim();
      } else {
        const firstItem = /(?:^|\r?\n)[\t ]*(?:\d+(?:\s*의\s*\d+)?\s*[.)]|제\s*\d+\s*호)/u.exec(segment);
        if (firstItem) segment = segment.slice(0, firstItem.index).trim();
      }
    } else {
      for (const number of itemNumbers) {
        segment = itemSegment(segment, number);
        if (!segment) return [];
      }
      const subitems = [...part.matchAll(/([가-힣])목/gu)].map((match) => match[1]);
      for (const letter of subitems) {
        segment = subitemSegment(segment, letter);
        if (!segment) return [];
      }
    }
    if (segment.trim()) segments.push(segment.trim());
  }
  return segments;
}

function assertClauseSemantics(documentText, spec) {
  must(Array.isArray(spec.semantics) && spec.semantics.length > 0,
    `Expected basis clause ${spec.locator} is missing semantic assertions`);
  for (const semantic of spec.semantics) {
    const segments = locatorSegments(documentText, semantic.locator);
    must(segments.length > 0 && segments.every((segment) => segment.length > 0),
      `Fetched law text must expose the exact clause ${semantic.locator}`);
    const clauseText = segments.join(" ").replace(/\s+/gu, " ");
    must(semantic.pattern.test(clauseText),
      `Fetched law text for ${semantic.locator} must support its pinned withholding role`);
  }
}

test("clause locator parser isolates statutory paragraphs, items, and subitems", () => {
  const incomeRateArticle = "①\n3. 원천징수대상 사업소득에 대해서는 100분의 3. 다만, 외국인 직업운동가 소득은 100분의 20으로 한다.\n6. 기타소득에 대해서는 다음 각 목에 따른다.\n가. 외국인 직업운동가의 해당 사업소득에 대해서는 100분의 20으로 한다.\n라. 그 밖의 기타소득에 대해서는 100분의 20으로 한다.\n마. 다른 소득은 별도 세율로 한다.\n②\n3. 별도 조항이다.";
  const businessRate = locatorSegments(incomeRateArticle, "제129조 제1항 제3호").join(" ");
  const otherIncomeRate = locatorSegments(incomeRateArticle, "제129조 제1항 제6호 라목").join(" ");
  must(/100\s*분의\s*3/u.test(businessRate), "The business rate locator must select item 3");
  must(/그\s*밖의\s*기타소득.*100\s*분의\s*20/u.test(otherIncomeRate) &&
    !/외국인\s*직업운동가/u.test(otherIncomeRate),
    "The other-income rate locator must select item 6, subitem 라, and exclude the foreign-athlete clause");

  const vatServiceArticle = "1. 이 호의 본문은 인적용역의 범위를 정한다.\n가. 가목이다.\n차. 강연 및 교육용역의 차목이다.\n카. 다른 용역이다.";
  const vatMain = locatorSegments(vatServiceArticle, "제42조 제1호 본문").join(" ");
  const vatLecture = locatorSegments(vatServiceArticle, "제42조 제1호 차목").join(" ");
  must(/인적용역/u.test(vatMain) && !/강연/u.test(vatMain), "The VAT decree main text must exclude subitems");
  must(/강연|교육용역/u.test(vatLecture) && !/다른 용역/u.test(vatLecture),
    "The VAT decree locator must isolate the lecture subitem");

  const personalServiceArticle = "1. 개인이 물적 시설 없이 근로자를 고용(고용 외의 형태로 해당 용역의 주된 업무에 대해 타인으로부터 노무 등을 제공받는 경우를 포함한다)하지 아니하고 독립된 자격으로 용역을 공급하고 대가를 받는다.\n가. 저술·도안·삽화·작곡·성우 용역이다.\n나. 연예에 관한 연출·촬영 용역이다.\n다. 다른 범위다.\n자. 교정·번역·속기 용역이다.\n차. 고용관계 없는 사람의 다수인 강연 용역이다.";
  assertClauseSemantics(personalServiceArticle, PERSONAL_SERVICE_GROUP_BASIS.creative);
  assertClauseSemantics(personalServiceArticle, PERSONAL_SERVICE_GROUP_BASIS.entertainment);
  assertClauseSemantics(personalServiceArticle, PERSONAL_SERVICE_GROUP_BASIS.language);
  must(!locatorSegments(personalServiceArticle, "제42조 제1호 가목").join(" ").includes("연예에 관한"),
    "The creative clause must not absorb a later entertainment subitem");
  must(!locatorSegments(personalServiceArticle, "제42조 제1호 나목").join(" ").includes("교정"),
    "The entertainment clause must not absorb the language subitem");

  const fundsArticle = "① 첫째 규정은 10원 미만 끝수를 처리한다.\n② 둘째 규정은 예외이다.";
  must(/10원/u.test(locatorSegments(fundsArticle, "제47조 제1항").join(" ")) &&
    !/예외/u.test(locatorSegments(fundsArticle, "제47조 제1항").join(" ")),
  "The funds first-paragraph locator must exclude the next paragraph");
  must(/예외/u.test(locatorSegments(fundsArticle, "제47조 제2항").join(" ")),
    "The funds second-paragraph locator must select the required exception");

  const expenseArticle = "1. 제1호 본문이다.\n1의2. 필요경비는 수입금액의 100분의 60으로 한다.\n2. 다른 항목이다.";
  const expense = locatorSegments(expenseArticle, "제87조 제1호의2").join(" ");
  must(/100\s*분의\s*60/u.test(expense) && !/다른 항목/u.test(expense),
    "The expense allowance locator must select subitem 1의2");

  const minimumArticle = "1. 첫째 기준이다.\n4. 기타소득금액이 5만원 이하이면 과세하지 아니한다.\n5. 다음 기준이다.";
  const minimum = locatorSegments(minimumArticle, "제84조 제4호").join(" ");
  must(/5만원/u.test(minimum) && !/다음 기준/u.test(minimum),
    "The other-income minimum locator must select item 4");

  must(locatorSegments("제29조(물적 시설) 사업설비를 계속 이용한다.", "제29조").length === 1,
    "An article-only locator must retain its complete article text");
});

test("clause locator parser isolates the selected other-income clauses and both Article 87 references", () => {
  const article21 = [
    "① 기타소득은 이자소득·배당소득·사업소득·근로소득·연금소득·퇴직소득 및 양도소득 외의 소득으로서 다음 각 호에서 규정하는 것으로 한다.",
    "15. 문예·학술·미술·음악 또는 사진에 속하는 창작품에 대한 원작자로서 받는 소득으로서 다음 각 목의 어느 하나에 해당하는 것",
    "가. 원고료",
    "나. 저작권사용료인 인세",
    "다. 미술·음악 또는 사진에 속하는 창작품에 대하여 받는 대가",
    "16. 다음 각 목의 소득",
    "가. 다른 소득",
    "17. 그 밖의 소득",
    "18. 기타 소득",
    "19. 다음 각 목의 어느 하나에 해당하는 인적용역(제15호부터 제17호까지의 규정을 적용받는 용역은 제외한다)을 일시적으로 제공하고 받는 대가",
    "가. 고용관계 없이 다수인에게 강연을 하고 강연료 등 대가를 받는 용역",
    "나. 라디오·텔레비전방송 등을 통하여 해설·계몽 또는 연기의 심사 등을 하고 보수 또는 이와 유사한 성질의 대가를 받는 용역",
    "다. 전문적 지식 또는 특별한 기능을 가진 자가 그 지식 또는 기능을 활용하여 보수 또는 그 밖의 대가를 받고 제공하는 용역",
    "20. 별도 규정이다.",
    "③ 기타소득금액은 해당 과세기간의 총수입금액에서 이에 사용된 필요경비를 공제한 금액으로 한다.",
  ].join("\n");
  for (const subtype of Object.keys(OTHER_PERSONAL_SERVICE_SUBTYPES)) {
    assertClauseSemantics(article21, OTHER_PERSONAL_SERVICE_SCOPE_BASIS[subtype]);
  }
  const manuscript = locatorSegments(article21, "제21조 제1항 제15호 가목").join(" ");
  const advisory = locatorSegments(article21, "제21조 제1항 제19호 다목").join(" ");
  const broadcast = locatorSegments(article21, "제21조 제1항 제19호 나목").join(" ");
  must(/원고료/u.test(manuscript) && !/인세|창작품에\s*대하여\s*받는\s*대가/u.test(manuscript),
    "The manuscript locator must exclude sibling royalty and creative-work consideration clauses");
  must(/전문적\s*지식/u.test(advisory) && !/라디오|텔레비전|강연/u.test(advisory),
    "The advisory locator must not borrow the broadcast or lecture sibling clauses");
  must(/방송/u.test(broadcast) && !/전문적\s*지식|강연/u.test(broadcast),
    "The broadcast locator must not borrow the advisory or lecture sibling clauses");

  const wrongManuscriptArticle = article21.replace("가. 원고료", "가. 다른 대가");
  const wrongAdvisoryArticle = article21.replace("다. 전문적 지식", "다. 일반 용역");
  const wrongBroadcastArticle = article21.replace("나. 라디오·텔레비전방송", "나. 온라인 게시물");
  for (const [text, subtype, message] of [
    [wrongManuscriptArticle, "manuscript_fee", "The manuscript assertion must reject a sibling clause without 원고료"],
    [wrongAdvisoryArticle, "expert_advisory", "The advisory assertion must reject a sibling clause without professional expertise"],
    [wrongBroadcastArticle, "broadcast_commentary", "The broadcast assertion must reject a sibling clause without broadcasting"],
  ]) {
    let rejected = false;
    try { assertClauseSemantics(text, OTHER_PERSONAL_SERVICE_SCOPE_BASIS[subtype]); }
    catch (error) { rejected = error instanceof AcceptanceFailure; }
    must(rejected, message);
  }

  const expenseArticle = [
    "1. another allowance",
    "1의2. 법 제21조제1항제7호·제8호의2·제9호·제15호 및 제19호의 기타소득에 대해서는 거주자가 받은 금액의 100분의 60에 상당하는 금액을 필요경비로 한다. 다만, 실제 소요된 필요경비가 거주자가 받은 금액의 100분의 60에 상당하는 금액을 초과하면 그 초과하는 금액도 필요경비에 산입한다.",
    "2. another item",
  ].join("\n");
  const expenseSpec = OTHER_REQUIRED_BASIS.find((spec) => spec.rule_id === "WH-CALC-OTHER-EXPENSE");
  assertClauseSemantics(expenseArticle, expenseSpec);
});

test("clause locator parser isolates actual-expense scope, exclusions, payer ascertainment and the Article 87 alternative", () => {
  const act37 = [
    "① 첫째 항은 별도 비용을 정한다.",
    "② 다음 각 호의 경우 외에는 해당 과세기간의 총수입금액에 대응하는 비용으로서 일반적으로 용인되는 통상적인 것의 합계액을 필요경비에 산입한다.",
    "③ 해당 과세기간 전의 총수입금액에 대응하는 비용은 이 항의 요건을 충족하는 경우만 필요경비로 본다.",
    "④ 기타소득금액을 계산할 때 필요경비에 산입하지 아니하는 금액에 관하여는 제33조를 준용한다.",
    "⑤ 후속 항은 별도 자산을 다룬다.",
  ].join("\n");
  const act33 = [
    "① 거주자가 해당 과세기간에 지급하였거나 지급할 금액 중 다음 각 호에 해당하는 것은 사업소득금액을 계산할 때 필요경비에 산입하지 아니한다.",
    "1. 소득세와 개인지방소득세",
    "2. 벌금·과료와 과태료",
    "3. 대통령령으로 정하는 가사 경비와 그 관련 비용",
    "4. 그 밖에 법률이 필요경비에 산입하지 아니하도록 정한 비용",
    "② 이 항은 앞 항의 번호를 바꾸지 않는다.",
  ].join("\n");
  const decree202 = [
    "① 법 제145조제1항의 규정에 의한 기타소득금액은 당해 지급금액에서 이에 대응하는 필요경비로 당해 원천징수의무자가 확인할 수 있는 금액 또는 제87조의 규정에 의한 필요경비를 공제한 금액으로 한다.",
    "② 다른 지급 기준으로 100만원을 정한다.",
  ].join("\n");
  assertClauseSemantics(act37, OTHER_ACTUAL_EXPENSE_BASIS[0]);
  assertClauseSemantics(act33, OTHER_ACTUAL_EXPENSE_BASIS[1]);
  assertClauseSemantics(decree202, OTHER_ACTUAL_EXPENSE_BASIS[2]);
  const selected37 = locatorSegments(act37, "제37조 제2항·제4항").join(" ");
  must(/해당 과세기간의 총수입금액에 대응/u.test(selected37) && /제33조를 준용/u.test(selected37) &&
    !/과세기간 전의 총수입금액/u.test(selected37),
  "The actual-expense locator must select paragraphs 2 and 4 without borrowing the prior-period rule in paragraph 3");
  const selected33 = locatorSegments(act33, "제33조 제1항").join(" ");
  must(/1\. 소득세와 개인지방소득세/u.test(selected33) && /2\. 벌금·과료와 과태료/u.test(selected33) &&
    /3\. .*가사 경비/u.test(selected33) && !/앞 항의 번호/u.test(selected33),
  "The Article 33 locator must retain the full first paragraph, including its numbered exclusion list");
  const selected202 = locatorSegments(decree202, "제202조 제1항").join(" ");
  must(/확인할 수 있는 금액/u.test(selected202) && /제87조.*필요경비/u.test(selected202) &&
    !/100만원/u.test(selected202),
  "The Article 202 locator must select payer-ascertainable expenses or the Article 87 alternative only");

  const reject = (text, spec, message) => {
    let rejected = false;
    try { assertClauseSemantics(text, spec); }
    catch (error) { rejected = error instanceof AcceptanceFailure; }
    must(rejected, message);
  };
  reject(act37.replace("② 다음 각 호의 경우 외에는 해당 과세기간의 총수입금액에 대응하는 비용으로서 일반적으로 용인되는 통상적인 것의 합계액을 필요경비에 산입한다.",
    "② 이 항은 별도 비용을 정한다."), OTHER_ACTUAL_EXPENSE_BASIS[0],
  "The current-period ordinary-expense rule in paragraph 2 must not be inferred from sibling paragraph 3");
  reject(act37.replace("④ 기타소득금액을 계산할 때 필요경비에 산입하지 아니하는 금액에 관하여는 제33조를 준용한다.",
    "④ 기타소득금액 계산은 다른 규정을 따른다."), OTHER_ACTUAL_EXPENSE_BASIS[0],
  "The Article 33 disallowance cross-reference must be present in paragraph 4");
  reject(act33.replace("1. 소득세와 개인지방소득세", "1. 다른 비용"), OTHER_ACTUAL_EXPENSE_BASIS[1],
  "The full Article 33 paragraph must include the tax exclusion, not only the paragraph heading");
  reject(decree202.replace("① 법 제145조제1항의 규정에 의한 기타소득금액은 당해 지급금액에서 이에 대응하는 필요경비로 당해 원천징수의무자가 확인할 수 있는 금액 또는 제87조의 규정에 의한 필요경비를 공제한 금액으로 한다.",
    "① 기타소득금액은 지급금액에서 다른 필요경비를 공제한다."), OTHER_ACTUAL_EXPENSE_BASIS[2],
  "Payer ascertainability and the Article 87 alternative must appear in paragraph 1");
  const allowanceWithoutActualProviso = [
    "1. another allowance",
    "1의2. 법 제21조제1항제15호 및 제19호의 기타소득에 대해서는 거주자가 받은 금액의 100분의 60에 상당하는 금액을 필요경비로 한다.",
    "2. another item",
  ].join("\n");
  reject(allowanceWithoutActualProviso,
    OTHER_REQUIRED_BASIS.find((spec) => spec.rule_id === "WH-CALC-OTHER-EXPENSE"),
    "The Article 87 actual-excess proviso must not be inferred from the 60% standard alone");
});

test("clause locator parser separates annual OTHER income from business-origin loss rules", () => {
  const article21 = [
    "① 기타소득은 다음 각 호의 소득으로 한다.",
    "② 제1항에도 불구하고 서화·골동품 양도소득은 별도로 규정한다.",
    "③ 기타소득금액은 해당 과세기간의 총수입금액에서 이에 사용된 필요경비를 공제한 금액으로 한다.",
  ].join("\n");
  const article45 = [
    "① 사업자가 비치·기록한 장부에 의하여 해당 과세기간의 사업소득금액을 계산할 때 발생한 결손금은 종합소득과세표준을 계산할 때 기타소득금액에서 순서대로 공제한다.",
    "② 부동산임대업에서 발생한 결손금은 주거용 건물 임대업 외에는 공제하지 아니한다.",
    "③ 부동산임대업에서 발생한 결손금과 제1항 및 제2항 단서에 따라 공제하고 남은 결손금(이하 이월결손금이라 한다)은 15년 이내에 끝나는 과세기간의 소득금액을 계산할 때 다음 각 호에 따라 공제한다.",
    "1. 제1항 및 제2항 단서에 따라 공제하고 남은 이월결손금은 사업소득금액, 근로소득금액, 연금소득금액, 기타소득금액, 이자소득금액 및 배당소득금액에서 순서대로 공제한다.",
    "2. 부동산임대업에서 발생한 이월결손금은 부동산임대업의 소득금액에서 공제한다.",
    "④ 추계신고를 한 경우에는 제3항을 적용하지 아니한다.",
  ].join("\n");
  assertClauseSemantics(article21, OTHER_LOSS_SCOPE_BASIS[0]);
  assertClauseSemantics(article45, OTHER_LOSS_SCOPE_BASIS[1]);
  const annualOther = locatorSegments(article21, "제21조 제3항").join(" ");
  must(/해당\s*과세기간의\s*총수입금액.*필요경비/u.test(annualOther) &&
    !/서화/u.test(annualOther),
  "The annual OTHER-income formula must be isolated to paragraph 3, not paragraph 2");
  const businessLoss = locatorSegments(article45, "제45조 제1항").join(" ");
  const carriedLoss = locatorSegments(article45, "제45조 제3항").join(" ");
  must(/사업자가\s*비치[ㆍ·]기록한\s*장부/u.test(businessLoss) &&
    /사업소득금액.*발생한\s*결손금/u.test(businessLoss) &&
    /기타소득금액에서/u.test(businessLoss),
  "Article 45 paragraph 1 must identify a business-origin loss and its annual deduction destination");
  const carriedLossText = carriedLoss.replace(/\s+/gu, " ");
  must(/제1항 및 제2항 단서에 따라 공제하고 남은 결손금/u.test(carriedLossText) &&
    /이월결손금.*15년/u.test(carriedLossText) &&
    /1\..*기타소득금액.*에서 순서대로 공제/u.test(carriedLossText) &&
    /2\..*부동산임대업의 소득금액에서 공제/u.test(carriedLossText) &&
    !/추계신고/u.test(carriedLossText),
  "Article 45 paragraph 3 must preserve both carry-deduction branches and exclude paragraph 4");

  const reject = (text, spec, message) => {
    let rejected = false;
    try { assertClauseSemantics(text, spec); }
    catch (error) { rejected = error instanceof AcceptanceFailure; }
    must(rejected, message);
  };
  reject(article21.replace(/③[^\n]*/u, "③ 별도 세율을 적용한다."), OTHER_LOSS_SCOPE_BASIS[0],
    "The annual OTHER formula must not be inferred from Article 21 paragraph 2");
  const wrongArticle45 = article45
    .replace(/①[^\n]*/u, "① 사업소득과 기타소득은 별도 절차를 따른다.")
    .replace(/③[^\n]*/u, "③ 이월결손금은 별도 절차를 따른다.");
  reject(wrongArticle45, OTHER_LOSS_SCOPE_BASIS[1],
    "Article 45 paragraphs 2 or 4 cannot substitute for the business-origin loss clauses in paragraphs 1 and 3");
});

test("clause locator parser matches sanitized current official Articles 21, 33, 37, 45, Decree 87 and Article 202 probes when configured", {
  skip: !process.env.AGENTLINK_TEST_TAX_OFFICIAL_PROBE_DIR,
}, () => {
  const directory = process.env.AGENTLINK_TEST_TAX_OFFICIAL_PROBE_DIR;
  const files = readdirSync(directory);
  const article21Path = files.find((name) => name.endsWith("소득세법_제21조.json"));
  const article33Path = files.find((name) => name.endsWith("소득세법_제33조.json"));
  const article37Path = files.find((name) => name.endsWith("소득세법_제37조.json"));
  const article45Path = files.find((name) => name.endsWith("소득세법_제45조.json"));
  const decree87Path = files.find((name) => name.endsWith("소득세법 시행령_제87조.json"));
  const decree202Path = files.find((name) => name.endsWith("소득세법 시행령_제202조.json"));
  must(article21Path && article33Path && article37Path && article45Path && decree87Path && decree202Path,
    "Configured sanitized official probe must include the current income-tax expense and withholding clauses");
  const article21 = JSON.parse(readFileSync(join(directory, article21Path), "utf8"));
  const article33 = JSON.parse(readFileSync(join(directory, article33Path), "utf8"));
  const article37 = JSON.parse(readFileSync(join(directory, article37Path), "utf8"));
  const article45 = JSON.parse(readFileSync(join(directory, article45Path), "utf8"));
  const decree87 = JSON.parse(readFileSync(join(directory, decree87Path), "utf8"));
  const decree202 = JSON.parse(readFileSync(join(directory, decree202Path), "utf8"));
  for (const [document, lawId, label] of [
    [article21, "001565", "Article 21"], [article33, "001565", "Article 33"],
    [article37, "001565", "Article 37"], [article45, "001565", "Article 45"],
    [decree87, "003956", "Decree 87"],
    [decree202, "003956", "Decree 202"],
  ]) {
    same(document.law_id, lawId, `Sanitized ${label} probe must retain its law identity`);
    same(document.article?.truncated, false, "Sanitized official probes must contain complete article text");
    same(createHash("sha256").update(document.article?.text ?? "", "utf8").digest("hex"), document.text_sha256,
      "Sanitized official probe text must retain its full-body hash");
  }
  for (const subtype of Object.keys(OTHER_PERSONAL_SERVICE_SUBTYPES)) {
    assertClauseSemantics(article21.article.text, OTHER_PERSONAL_SERVICE_SCOPE_BASIS[subtype]);
  }
  const article21Calculation = OTHER_PERSONAL_SERVICE_MAIN_BASIS[0];
  assertClauseSemantics(article21.article.text, article21Calculation);
  for (const spec of OTHER_LOSS_SCOPE_BASIS) {
    assertClauseSemantics(spec.article === "제21조" ? article21.article.text : article45.article.text, spec);
  }
  const expenseSpec = OTHER_REQUIRED_BASIS.find((spec) => spec.rule_id === "WH-CALC-OTHER-EXPENSE");
  assertClauseSemantics(decree87.article.text, expenseSpec);
  for (const spec of OTHER_ACTUAL_EXPENSE_BASIS.filter((item) => item.article === "제37조")) {
    assertClauseSemantics(article37.article.text, spec);
  }
  for (const spec of OTHER_ACTUAL_EXPENSE_BASIS.filter((item) => item.article === "제33조")) {
    assertClauseSemantics(article33.article.text, spec);
  }
  for (const spec of OTHER_ACTUAL_EXPENSE_BASIS.filter((item) => item.article === "제202조")) {
    assertClauseSemantics(decree202.article.text, spec);
  }
});

function assertMatchedBasis(result, paymentDate, expectedProfile, trustedPayments) {
  const evidence = result.legal_evidence ?? [];
  const calculated = (result.withholding_calculations ?? []).filter((row) => row.status === "computed");
  must(calculated.length > 0, "Matched-basis check needs at least one computed payment");
  const inputs = new Map((trustedPayments ?? []).map((item) => [item.payment_id, item]));
  for (const row of calculated) {
    const input = inputs.get(row.payment_id);
    must(input, `${row.payment_id} must have a trusted input row for basis selection`);
    same(input.withholding_profile, expectedProfile,
      `${row.payment_id} trusted input must use the expected basis profile`);
    same(row.profile, input.withholding_profile, `${row.payment_id} must retain the selected basis profile`);
    const expectedSubtype = expectedProfile === "business_personal_service" ? input.service_subtype : undefined;
    const expectedOtherSubtype = expectedProfile === "other_personal_service" ? input.other_service_subtype : undefined;
    if (expectedSubtype !== undefined) same(row.service_subtype, expectedSubtype,
      `${row.payment_id} must echo the trusted service subtype`);
    if (expectedOtherSubtype !== undefined) same(row.other_service_subtype, expectedOtherSubtype,
      `${row.payment_id} must echo the trusted other-service subtype`);
    const selectedMethod = expectedProfile === "other_lecture" || expectedProfile === "other_personal_service"
      ? input.expenses_exceed_standard === true ? "actual" : "standard_60" : null;
    same(row.expense_method ?? null, selectedMethod,
      `${row.payment_id} must expose the expense method selected by trusted input facts`);
    const lossScopeExpected = expectsOtherLossScope(input);
    const expectedSpecs = specsForProfile(expectedProfile, expectedSubtype, expectedOtherSubtype,
      selectedMethod ?? "standard_60", lossScopeExpected);
    const expectedBasisKeys = new Set(expectedSpecs.map(basisKey));
    const expectedRuleIds = [...new Set(expectedSpecs.map((spec) => spec.rule_id))].sort();
    const rowRuleIds = [...new Set(row.rule_ids ?? [])].sort();
    equivalent(rowRuleIds, expectedRuleIds, `${row.payment_id} must expose exactly the required calculation rules`);
    const checks = row.basis_checks ?? [];
    const actualBasisKeys = new Set(checks.map(basisKey));
    equivalent([...actualBasisKeys].sort(), [...expectedBasisKeys].sort(),
      `${row.payment_id} must expose exactly the required law/article/locator basis set`);
    same(checks.length, expectedSpecs.length, `${row.payment_id} must not duplicate or omit a required basis check`);
    for (const check of row.basis_checks ?? []) {
      const spec = expectedSpecs.find((item) => basisKey(item) === basisKey(check));
      must(spec, `${row.payment_id} returned an unexpected rule or source clause`);
      same(check.status, "matched_pinned_current_text", `Basis must match pinned current text for ${check.article}`);
      same(check.instrument_id, INSTRUMENT_BY_LAW_ID[spec.law_id],
        `Basis ${check.article} must identify the exact public legal instrument`);
      for (const field of ["rule_id", "instrument_id", "locator", "law_id", "article", "effective_date",
        "article_effective_date", "retrieved_at", "source_link"]) {
        must(typeof check[field] === "string" && check[field].length > 0,
          `Basis ${check.article} is missing ${field}`);
      }
      must(/^[0-9a-f]{64}$/.test(check.expected_text_sha256) &&
        check.actual_text_sha256 === check.expected_text_sha256,
      `Basis ${check.article} must match its pinned SHA-256`);
      must(check.effective_date <= paymentDate && check.article_effective_date <= paymentDate,
        `Basis ${check.article} must be effective on the payment date`);
      must(typeof check.source_link === "string" && check.source_link.startsWith("https://") &&
        check.source_link.includes("law.go.kr"), `Basis ${check.article} must link to the official law source`);
      must(/(?:Z|[+-]\d{2}:\d{2})$/.test(check.retrieved_at) && Number.isFinite(Date.parse(check.retrieved_at)),
        `Basis ${check.article} must include a timezone-aware retrieval timestamp`);
      const retrievalAgeMs = Date.now() - Date.parse(check.retrieved_at);
      must(retrievalAgeMs <= 24 * 60 * 60 * 1000 && retrievalAgeMs >= -5 * 60 * 1000,
        `Basis ${check.article} retrieval time must be fresh`);
      same(kstDate(new Date(check.retrieved_at)), paymentDate,
        `Basis ${check.article} must be retrieved on the matter's KST date`);
      const source = evidence.find((item) => item.status === "fetched" && item.instrument_id === check.instrument_id &&
        item.locator === check.locator && item.article === check.article && item.document?.law_id === check.law_id);
      must(source, `Basis ${check.article} must resolve to its fetched legal-evidence row`);
      const document = source.document;
      same(document.verification, "fetched_text_not_compared",
        `API response verification for ${check.article} must remain unpromoted`);
      same(document.status, "ok", `Fetched ${check.article} identity must be successful`);
      same(document.text_sha256, check.actual_text_sha256, `Attached hash for ${check.article} must match the calculation basis`);
      same(document.effective_date, check.effective_date, `Attached version for ${check.article} must match the basis`);
      same(document.article?.article_effective_date, check.article_effective_date,
        `Attached article version for ${check.article} must match the basis`);
      same(document.retrieved_at, check.retrieved_at, `Attached retrieval time for ${check.article} must match the basis`);
      same(document.source_link, check.source_link, `Attached source link for ${check.article} must match the basis`);
      must(typeof document.law_name === "string" && document.law_name.length > 0 &&
        typeof document.promulgation_no === "string" && document.promulgation_no.length > 0 &&
        typeof document.article?.text === "string" && document.article.text.trim().length > 0,
      `Fetched ${check.article} must include its identity and full article text`);
      same(document.article.label, check.article, `Fetched article locator for ${check.article} must match the basis`);
      same(document.text_check_draft?.law_id, check.law_id, `Fetched law ID for ${check.article} must match its source metadata`);
      same(document.text_check_draft?.promulgation_no, document.promulgation_no,
        `Fetched promulgation identity for ${check.article} must be internally consistent`);
      same(document.text_check_draft?.effective_date, check.effective_date,
        `Fetched version metadata for ${check.article} must match the pinned basis`);
      same(document.article.truncated, false, `Fetched ${check.article} must not be truncated`);
      const bodyHash = createHash("sha256").update(document.article.text, "utf8").digest("hex");
      same(bodyHash, check.actual_text_sha256, `Fetched ${check.article} body must match the reported hash`);
      assertClauseSemantics(document.article.text, spec);
    }
  }
}

function assertCurrentCalculationDate() {
  const today = kstDate();
  must(today >= "2026-10-20" && today <= "2026-12-31",
    "Live withholding calculation acceptance requires the current KST date to be within 2026-10-20 through 2026-12-31");
  return today;
}

function lecturePayment(profile, gross, paymentId, paymentDate) {
  const business = profile === "business_lecture";
  return {
    payment_id: paymentId,
    income_type: business ? "business" : "other",
    payee_type: "resident",
    payee_entity: "individual",
    payment_date: paymentDate,
    gross_amount: gross,
    withholding_profile: profile,
    domestic_payment: true,
    lecture_to_many: true,
    employment_relationship: false,
    independent_service: true,
    has_business_facilities: false,
    uses_hired_labor: false,
    special_tax_treatment: false,
    single_payment_complete: true,
    expenses_exceed_standard: false,
    activity_continuity: business ? "continuing" : "temporary",
  };
}

function personalServicePayment(serviceSubtype, gross, paymentId, paymentDate) {
  return {
    payment_id: paymentId,
    income_type: "business",
    payee_type: "resident",
    payee_entity: "individual",
    payment_date: paymentDate,
    gross_amount: gross,
    withholding_profile: "business_personal_service",
    service_subtype: serviceSubtype,
    domestic_payment: true,
    employment_relationship: false,
    independent_service: true,
    activity_continuity: "continuing",
    has_business_facilities: false,
    uses_hired_labor: false,
    special_tax_treatment: false,
    single_payment_complete: true,
    // These lecture and other-income facts are irrelevant to this profile.
    lecture_to_many: false,
    expenses_exceed_standard: true,
  };
}

function otherPersonalServicePayment(otherServiceSubtype, gross, paymentId, paymentDate) {
  return {
    payment_id: paymentId,
    income_type: "other",
    payee_type: "resident",
    payee_entity: "individual",
    payment_date: paymentDate,
    gross_amount: gross,
    withholding_profile: "other_personal_service",
    other_service_subtype: otherServiceSubtype,
    other_service_scope_confirmed: true,
    domestic_payment: true,
    employment_relationship: false,
    independent_service: true,
    activity_continuity: "temporary",
    has_business_facilities: true,
    uses_hired_labor: true,
    special_tax_treatment: false,
    single_payment_complete: true,
    lecture_to_many: false,
    expenses_exceed_standard: false,
  };
}

function actualExpensePayment(profile, subtype, gross, expense, paymentId, paymentDate, actualWithheld) {
  const payment = profile === "other_lecture"
    ? lecturePayment(profile, gross, paymentId, paymentDate)
    : otherPersonalServicePayment(subtype, gross, paymentId, paymentDate);
  payment.expenses_exceed_standard = true;
  payment.actual_expense_amount = expense;
  payment.actual_expense_scope_confirmed = true;
  if (actualWithheld !== undefined) payment.withheld_amount = actualWithheld;
  return payment;
}

function calculationMatter(payments, asOf, matterId) {
  return {
    matter_id: matterId,
    workflow_id: "withholding-payment",
    as_of: asOf,
    taxpayer: { type: "corporation", small_business_semiannual_approval: false },
    facts: { payments },
  };
}

function retryableCalculationBudgetFailure(result, paymentIds, expectedSelections) {
  const rows = result.withholding_calculations ?? [];
  const selectedRows = paymentIds.map((paymentId) => rows.find((row) => row.payment_id === paymentId));
  if (selectedRows.some((row) => !row)) return false;
  let timedOutRequiredBasis = false;
  for (const row of selectedRows) {
    const expected = expectedSelections.get(row.payment_id);
    if (!expected || row.profile !== expected.profile || row.expense_method !== expected.expenseMethod ||
      (expected.serviceSubtype !== undefined && row.service_subtype !== expected.serviceSubtype) ||
      (expected.otherServiceSubtype !== undefined && row.other_service_subtype !== expected.otherServiceSubtype)) return false;
    const specs = specsForProfile(expected.profile, expected.serviceSubtype, expected.otherServiceSubtype,
      expected.expenseMethod ?? "standard_60", expected.lossScopeExpected);
    const expectedKeys = new Set(specs.map(basisKey));
    const checks = row.basis_checks ?? [];
    const checkKeys = new Set(checks.map(basisKey));
    if (checks.length !== specs.length || checkKeys.size !== specs.length ||
      [...checkKeys].some((key) => !expectedKeys.has(key))) return false;

    if (row.status === "computed") {
      if (checks.some((check) => check.status !== "matched_pinned_current_text")) return false;
      continue;
    }
    if (row.status !== "blocked") return false;
    assertNoCalculatedAmounts({ withholding_calculations: [row] }, [row.payment_id],
      "A blocked required-basis row must not expose calculated amounts before retry");
    if (JSON.stringify(row.reason_codes ?? []) !== '["time_budget_exceeded"]') return false;
    let thisRowTimedOut = false;
    for (const check of checks) {
      if (check.status === "matched_pinned_current_text") continue;
      if (check.status === "unavailable" && check.reason === "time_budget_exceeded") {
        thisRowTimedOut = true;
        continue;
      }
      // Any other unavailable, stale, mismatched, or unclassified basis makes this non-retryable.
      return false;
    }
    if (!thisRowTimedOut) return false;
    timedOutRequiredBasis = true;
  }
  return timedOutRequiredBasis;
}

async function planWithBoundedBudgetRetries(call, matterValue, retryBudget, paymentIds) {
  const expectedSelections = new Map((matterValue.facts?.payments ?? [])
    .filter((item) => paymentIds.includes(item.payment_id))
    .map((item) => [item.payment_id, {
      profile: item.withholding_profile,
      serviceSubtype: item.service_subtype,
      otherServiceSubtype: item.other_service_subtype,
      expenseMethod: item.withholding_profile === "other_lecture" || item.withholding_profile === "other_personal_service"
        ? item.expenses_exceed_standard === true ? "actual" : item.expenses_exceed_standard === false ? "standard_60" : null
        : null,
      lossScopeExpected: expectsOtherLossScope(item),
    }]));
  if (expectedSelections.size !== paymentIds.length) {
    throw new AcceptanceFailure("Retry gate requires a known selected profile for every payment");
  }
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await call("tax_plan_work", { matter: matterValue, include_evidence: true });
    if (!retryableCalculationBudgetFailure(result, paymentIds, expectedSelections)) return { result, attempts };
    must(retryBudget.used < 2, "Live calculation evidence exceeded the two-call time-budget retry limit");
    retryBudget.used += 1;
  }
}

function payment() {
  return {
    payment_id: "live-evidence-wage",
    income_type: "wage",
    payee_type: "resident",
    payment_date: "2026-03-25",
    gross_amount: 3_000_000,
    withheld_amount: "10000",
  };
}

function matter(payments = [payment()]) {
  return {
    matter_id: "live-evidence-acceptance",
    workflow_id: "withholding-payment",
    as_of: "2026-04-01",
    taxpayer: { type: "corporation", small_business_semiannual_approval: false },
    facts: { payments },
  };
}

function credentialEnvironment() {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = process.env.HOME;
  env.TMPDIR = taskTemp;
  return env;
}

function savePrivateLiveReceipt(receiptContent) {
  const receipt = process.env.AGENTLINK_TEST_TAX_LIVE_RECEIPT;
  if (receipt === undefined) return;
  const scratchRoot = resolve(dirname(taskTemp));
  const destination = resolve(receipt);
  const rel = relative(scratchRoot, destination);
  must(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`),
    "Private live receipt must stay under task scratch");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(destination, JSON.stringify(receiptContent, null, 2),
      { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(destination, 0o600);
  } catch {
    throw new AcceptanceFailure("Private live receipt could not be written safely");
  }
}

function verifyInstalledWheel(scratch) {
  const probe = String.raw`
import importlib.metadata as metadata
import json
import pathlib
import sysconfig

import agentlink_tax
from agentlink_tax.credentials import CredentialStore, LAW_GO_KR
from agentlink_tax.registry import default_registry_dir

package = pathlib.Path(agentlink_tax.__file__).resolve().parent
site_packages = pathlib.Path(sysconfig.get_paths()["purelib"]).resolve()
registry = pathlib.Path(default_registry_dir()).resolve()
dist = metadata.distribution("agentlink-domain-tax")
direct_url = dist.read_text("direct_url.json")
editable = bool(json.loads(direct_url).get("dir_info", {}).get("editable")) if direct_url else False
required_assets = {"workflows.json", "instruments.json", "forms.json", "automation_offer.json"}
assets = {path.name for path in registry.rglob("*.json") if path.is_file()}
withholding_rules = registry / "rules" / "withholding.json"
workflows_file = registry / "workflows.json"
rule_rows = json.loads(withholding_rules.read_text(encoding="utf-8")).get("rules", []) if withholding_rules.is_file() else []
workflow_rows = json.loads(workflows_file.read_text(encoding="utf-8")).get("workflows", []) if workflows_file.is_file() else []
withholding_workflow = next((row for row in workflow_rows if row.get("id") == "withholding-payment"), {})
calculation_rule_count = sum(1 for row in rule_rows if str(row.get("id", "")).startswith("WH-CALC-"))
personal_service_rule_ids = sorted(str(row.get("id", "")) for row in rule_rows
    if str(row.get("id", "")).startswith("WH-CALC-PERSONAL-"))
other_personal_service_rule_ids = sorted(str(row.get("id", "")) for row in rule_rows
    if str(row.get("id", "")) in {"WH-CALC-OTHER-SERVICE", "WH-CALC-OTHER-MANUSCRIPT",
        "WH-CALC-OTHER-ADVISORY", "WH-CALC-OTHER-BROADCAST"})
actual_expense_rule_ids = sorted(str(row.get("id", "")) for row in rule_rows
    if str(row.get("id", "")) in {"WH-CALC-OTHER-ACTUAL-SCOPE", "WH-CALC-OTHER-ACTUAL-WITHHOLDING"})
loss_scope_rule_ids = sorted(str(row.get("id", "")) for row in rule_rows
    if str(row.get("id", "")) == "WH-CALC-OTHER-LOSS-SCOPE")
print(json.dumps({
    "package_installed": package.is_relative_to(site_packages),
    "registry_bundled": registry.is_relative_to(package) and required_assets <= assets,
    "calculation_rules_bundled": withholding_rules.is_file() and calculation_rule_count == 22 and
        personal_service_rule_ids == ["WH-CALC-PERSONAL-CREATIVE", "WH-CALC-PERSONAL-ENTERTAINMENT",
            "WH-CALC-PERSONAL-LANGUAGE"] and
        other_personal_service_rule_ids == ["WH-CALC-OTHER-ADVISORY", "WH-CALC-OTHER-BROADCAST",
            "WH-CALC-OTHER-MANUSCRIPT", "WH-CALC-OTHER-SERVICE"] and
        actual_expense_rule_ids == ["WH-CALC-OTHER-ACTUAL-SCOPE", "WH-CALC-OTHER-ACTUAL-WITHHOLDING"] and
        loss_scope_rule_ids == ["WH-CALC-OTHER-LOSS-SCOPE"] and
        any(str(row.get("id", "")) == "WH-CALC-OTHER-EXPENSE" for row in rule_rows) and
        "business_lecture" in withholding_workflow.get("description", "") and
        "other_lecture" in withholding_workflow.get("description", "") and
        "business_personal_service" in withholding_workflow.get("description", "") and
        "other_personal_service" in withholding_workflow.get("description", "") and
        "manuscript_fee" in withholding_workflow.get("description", "") and
        "expert_advisory" in withholding_workflow.get("description", "") and
        "broadcast_commentary" in withholding_workflow.get("description", "") and
        "actual_expense_amount" in withholding_workflow.get("description", "") and
        "actual_expense_scope_confirmed" in withholding_workflow.get("description", ""),
    "editable": editable,
    "credential_present": CredentialStore().has(LAW_GO_KR),
}, separators=(",", ":")))
`;
  const env = credentialEnvironment();
  const result = spawnSync(python, ["-I", "-B", "-c", probe], {
    cwd: scratch, env, encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024,
  });
  must(result.status === 0, "Installed tax environment probe failed");
  let facts;
  try { facts = JSON.parse(result.stdout); } catch { throw new AcceptanceFailure("Installed tax environment probe returned invalid metadata"); }
  same(facts.package_installed, true, "Tax package must import from installed site-packages");
  same(facts.registry_bundled, true, "Canonical JSON registry must be bundled with the installed package");
  same(facts.calculation_rules_bundled, true,
    "All supported lecture, personal-service, other-personal-service, actual-expense, and conditional loss-scope rule cards must be bundled with the installed package");
  same(facts.editable, false, "Installed tax package must not be editable");
  same(facts.credential_present, true, "Existing law.go.kr credential must be available to the installed child");
}

async function withUpper(scratch, credentialPath, run) {
  const env = credentialEnvironment();
  env.TMPDIR = scratch;
  env.AGENTLINK_TAX_MCP_COMMAND = python;
  env.AGENTLINK_TAX_MCP_ARGS = JSON.stringify(["-I", "-B", "-m", "agentlink_tax.server"]);
  if (credentialPath !== undefined) env.AGENTLINK_CREDENTIALS_PATH = credentialPath;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: scratch,
    stderr: "pipe",
    env,
  });
  // Drain diagnostics without keeping or displaying text that may contain transport internals.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "tax-live-evidence-acceptance", version: "0.1.0" });
  client.onerror = () => {};
  try {
    try { await client.connect(transport); } catch { throw new AcceptanceFailure("Upper MCP stdio failed to start"); }
    const call = async (name, args = {}) => {
      let response;
      try { response = await client.callTool({ name, arguments: args }); }
      catch { throw new AcceptanceFailure(`MCP call failed: ${name}`); }
      must(response.isError !== true, `MCP tool returned an error: ${name}`);
      const packet = response.structuredContent;
      must(packet && typeof packet === "object", `MCP tool omitted structured content: ${name}`);
      const text = response.content?.find((item) => item.type === "text")?.text;
      must(typeof text === "string", `MCP tool omitted text content: ${name}`);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new AcceptanceFailure(`MCP text result was not JSON: ${name}`); }
      equivalent(parsed, packet, `MCP text and structured content differed: ${name}`);
      return packet;
    };
    return await run(client, call);
  } finally {
    try { await client.close(); } catch { /* close errors do not replace acceptance results */ }
  }
}

test("installed wheel returns current law and opted-in withholding evidence through real stdio", {
  timeout: 120_000,
}, async () => {
  const calculationDate = assertCurrentCalculationDate();
  must(typeof python === "string" && existsSync(python), "AGENTLINK_TEST_TAX_PYTHON must name the installed-wheel interpreter");
  must(typeof taskTemp === "string" && existsSync(taskTemp), "TMPDIR must point to the task scratch directory");
  for (const key of OVERRIDE_KEYS) same(process.env[key], undefined, "Source and registry overrides are not allowed");
  must(process.env.HOME && existsSync(process.env.HOME), "The real credential-store home must be available");
  must(existsSync(serverPath), "Build the upper MCP server before running required live acceptance");

  const scratch = mkdtempSync(join(taskTemp, "tax-live-acceptance-"));
  chmodSync(scratch, 0o700);
  try {
    verifyInstalledWheel(scratch);
    await withUpper(scratch, undefined, async (_client, call) => {
      const listed = await _client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      same(names.filter((name) => name.startsWith("tax_")).length, 22, "Upper MCP must expose all 22 verified tax tools");
      must(names.includes("tax_route_question") && names.includes("tax_health"),
        "Upper MCP must expose the required route and health tools");
      must(names.includes("tax_get_law_article"), "Upper MCP must expose the native law-article tool");

      const search = await call("tax_search_law", { query: "소득세법", target: "law", limit: 10 });
      same(search.status, "ok", "Live law search must succeed");
      must(Array.isArray(search.results), "Live law search must return result rows");
      const exact = search.results.find((row) => row?.title === "소득세법" && typeof row.id === "string" && row.id.length > 0);
      must(exact, "Live law search must return an exact 소득세법 ID");

      const article = await call("tax_get_law_article", {
        law_name: "소득세법", article: "제128조", law_id: exact.id,
      });
      same(article.status, "ok", "Fetched current article must succeed");
      must(typeof article.article?.text === "string" && article.article.text.trim().length > 0,
        "Fetched article must include official text");
      must(typeof article.text_sha256 === "string" && /^[0-9a-f]{64}$/.test(article.text_sha256),
        "Fetched article must include a text hash");
      must(typeof article.effective_date === "string" && article.effective_date.length > 0,
        "Fetched article must include its effective date");
      must(typeof article.retrieved_at === "string" && article.retrieved_at.length > 0,
        "Fetched article must include its retrieval timestamp");
      must(typeof article.source_link === "string" && article.source_link.startsWith("https://"),
        "Fetched article must include an official source link");
      same(article.verification, "fetched_text_not_compared", "Fetched text must remain unverified against the registry");

      const empty = await call("tax_plan_work", { matter: matter([]), include_evidence: true });
      same(empty.status, "needs_facts", "An empty payments matter must remain needs_facts");
      const fullMatter = matter();
      const without = await call("tax_plan_work", { matter: fullMatter, include_evidence: false });
      const withEvidence = await call("tax_plan_work", { matter: fullMatter, include_evidence: true });
      same(withEvidence.status, "draft_ready", "Evidence retrieval must preserve draft_ready status");
      for (const field of ["status", "questions", "next_actions", "why", "sources", "applicability", "calculation_status"]) {
        equivalent(withEvidence[field], without[field], `Evidence retrieval changed plan authority field: ${field}`);
      }
      same(withEvidence.evidence_lookup?.status, "completed", "Required live evidence must complete without partial results");
      must(withEvidence.evidence_lookup.legal_documents_count >= 4, "Live evidence must attach at least four unique law documents");
      const fetchedRows = new Map((withEvidence.legal_evidence ?? [])
        .filter((row) => row.status === "fetched" && row.document?.article?.text?.trim())
        .map((row) => [row.article, row]));
      for (const label of ["제128조", "제164조", "제164조의3", "제5조"]) {
        const row = fetchedRows.get(label);
        must(row, `Live evidence is missing fetched ${label}`);
        const document = row.document;
        must(typeof row.instrument_id === "string" && row.instrument_id.length > 0 &&
          typeof row.locator === "string" && row.locator.length > 0 && row.scope === "current_law_not_historical",
        `Live evidence provenance is incomplete for ${label}`);
        must(typeof document.law_id === "string" && document.law_id.length > 0 &&
          typeof document.law_name === "string" && document.law_name.length > 0 &&
          typeof document.source === "string" && document.source.length > 0,
        `Live evidence identity is incomplete for ${label}`);
        must(typeof document.retrieved_at === "string" && document.retrieved_at.length > 0 &&
          typeof document.effective_date === "string" && document.effective_date.length > 0,
        `Live evidence dates are incomplete for ${label}`);
        must(typeof document.text_sha256 === "string" && /^[0-9a-f]{64}$/.test(document.text_sha256) &&
          typeof document.source_link === "string" && document.source_link.startsWith("https://") &&
          document.source_link.includes("law.go.kr"),
        `Live evidence source metadata is incomplete for ${label}`);
        same(document.verification, "fetched_text_not_compared", `Live evidence verification changed for ${label}`);
      }
      const candidate = (withEvidence.evidence_candidates ?? []).find((row) =>
        row.id && row.source && row.date && row.retrieved_at && (row.agency || row.case_no) &&
        (row.public_link || row.detail_link) && row.relevance === "query_match_unreviewed" &&
        row.verification_status === "candidate_unverified");
      must(candidate, "Live evidence must contain a sourced, dated interpretation candidate");
      must(withEvidence.evidence_lookup.candidate_count > 0, "Live evidence summary must count interpretation candidates");
      const resolvedForm = (withEvidence.forms_and_evidence?.forms ?? []).some((row) =>
        row.official_file_status === "resolved" && row.official_file);
      must(resolvedForm, "Live evidence must resolve at least one official form");
      must(!(withEvidence.unresolved ?? []).some((row) => row.code === "EVIDENCE_LOOKUP_UNAVAILABLE"),
        "Required live acceptance cannot contain an evidence-unavailable warning");

      const defaultAnswer = await call("tax_answer_practitioner_question", { matter: fullMatter, include_evidence: false });
      const answer = await call("tax_answer_practitioner_question", { matter: fullMatter, include_evidence: true });
      same(answer.final_decision, "not_issued", "Practitioner evidence must not issue a final decision");
      same(answer.applicability, "not_determined", "Practitioner evidence must not decide applicability");
      equivalent(answer.assessments, defaultAnswer.assessments, "Practitioner evidence must preserve assessments");
      must(Array.isArray(answer.assessments) && answer.assessments.length > 0 &&
        answer.assessments.every((item) => item.reliance === "do_not_rely_verify_source"),
      "Practitioner assessments must retain their existing reliance warning");
      const sections = answer.perspective_view?.sections ?? {};
      same(sections.evidence_lookup?.[0]?.text?.includes("조회 상태: completed"), true,
        "Practitioner evidence summary must report completed live retrieval");
      must(Array.isArray(sections.source_evidence) && sections.source_evidence.length > 0,
        "Practitioner evidence section must contain law and interpretation evidence");
      const law128 = fetchedRows.get("제128조").document;
      const law128Text = sections.source_evidence.find((row) => row.text?.includes("제128조") &&
        row.text.includes("fetched_text_not_compared"));
      must(law128Text && law128Text.text.includes(law128.article.text) &&
        law128Text.text.includes(law128.law_id) && law128Text.text.includes(law128.law_name) &&
        law128Text.text.includes(law128.retrieved_at) && law128Text.text.includes(law128.effective_date) &&
        law128Text.text.includes(law128.source_link),
      "Practitioner source evidence must contain the fetched article 128 body and provenance");
      const candidateLink = candidate.public_link || candidate.detail_link;
      must(sections.source_evidence.some((row) => row.text?.includes(`ID: ${candidate.id}`) &&
        row.text.includes(candidate.source) && row.text.includes(candidate.date) &&
        row.text.includes(candidate.retrieved_at) && row.text.includes(candidateLink) &&
        row.text.includes("query_match_unreviewed") && row.text.includes("candidate_unverified")),
      "Practitioner source evidence must include the actual unreviewed candidate and provenance");

      const businessMatter = calculationMatter([
        lecturePayment("business_lecture", 33333, "business-33333", calculationDate),
        lecturePayment("business_lecture", 10000, "business-10000", calculationDate),
      ], calculationDate, "live-business-lecture");
      businessMatter.facts.payments[0].withheld_amount = "1000";
      const otherMatter = calculationMatter([
        lecturePayment("other_lecture", 125000, "other-125000", calculationDate),
        lecturePayment("other_lecture", 125001, "other-125001", calculationDate),
        lecturePayment("other_lecture", 1000000, "other-1000000", calculationDate),
      ], calculationDate, "live-other-lecture");
      const otherPersonalPayments = [
        otherPersonalServicePayment("manuscript_fee", 1000000, "other-service-manuscript-1000000", calculationDate),
        otherPersonalServicePayment("expert_advisory", 1000000, "other-service-advisory-1000000", calculationDate),
        otherPersonalServicePayment("broadcast_commentary", 1000000, "other-service-broadcast-1000000", calculationDate),
        otherPersonalServicePayment("manuscript_fee", 125000, "other-service-manuscript-125000", calculationDate),
        otherPersonalServicePayment("expert_advisory", 125001, "other-service-advisory-125001", calculationDate),
        otherPersonalServicePayment("broadcast_commentary", 1000123, "other-service-broadcast-1000123", calculationDate),
      ];
      otherPersonalPayments.find((item) => item.payment_id === "other-service-advisory-125001").withheld_amount = "10000";
      otherPersonalPayments.find((item) => item.payment_id === "other-service-broadcast-1000000").withheld_amount = "88000";
      const otherPersonalMatter = calculationMatter(otherPersonalPayments, calculationDate,
        "live-other-personal-service");
      const actualExpensePayments = [
        actualExpensePayment("other_lecture", undefined, 1000000, 700000,
          "other-actual-lecture-1000000", calculationDate, "60000"),
        actualExpensePayment("other_personal_service", "manuscript_fee", 1000000, 700000,
          "other-actual-service-manuscript-1000000", calculationDate),
        actualExpensePayment("other_personal_service", "expert_advisory", 1000000, 700000,
          "other-actual-service-advisory-1000000", calculationDate, "66000"),
        actualExpensePayment("other_personal_service", "broadcast_commentary", 1000000, 700000,
          "other-actual-service-broadcast-1000000", calculationDate),
        actualExpensePayment("other_lecture", undefined, 200000, 150000,
          "other-actual-boundary-50000", calculationDate),
        actualExpensePayment("other_personal_service", "manuscript_fee", 200000, 149999,
          "other-actual-boundary-50001", calculationDate),
        actualExpensePayment("other_personal_service", "expert_advisory", 1000000, 600001,
          "other-actual-boundary-600001", calculationDate),
        actualExpensePayment("other_personal_service", "broadcast_commentary", 1000123, 700000,
          "other-actual-boundary-odd-gross", calculationDate),
        actualExpensePayment("other_lecture", undefined, 1000000, 1000000,
          "other-actual-boundary-full-gross", calculationDate),
      ];
      const actualExpenseMatter = calculationMatter(actualExpensePayments, calculationDate,
        "live-other-actual-expenses");
      const lossPayments = [
        actualExpensePayment("other_lecture", undefined, 1000000, 1200000,
          "loss-other-lecture", calculationDate, "0"),
        actualExpensePayment("other_personal_service", "manuscript_fee", 1000000, 1200000,
          "loss-other-manuscript", calculationDate, "66000"),
        actualExpensePayment("other_personal_service", "expert_advisory", 1000000, 1200000,
          "loss-other-advisory", calculationDate),
        actualExpensePayment("other_personal_service", "broadcast_commentary", 1000000, 1200000,
          "loss-other-broadcast", calculationDate),
        actualExpensePayment("other_lecture", undefined, 1000000, 1000001,
          "loss-one-won-excess", calculationDate),
        actualExpensePayment("other_personal_service", "manuscript_fee", 0, 1,
          "loss-zero-gross", calculationDate),
        actualExpensePayment("other_personal_service", "broadcast_commentary", 1000123, 1000124,
          "loss-odd-gross", calculationDate),
      ];
      const lossMatter = calculationMatter(lossPayments, calculationDate, "live-other-loss-scope");
      const isolationMissingScope = actualExpensePayment("other_personal_service", "manuscript_fee",
        1000000, 1200000, "isolation-missing-scope", calculationDate);
      delete isolationMissingScope.actual_expense_scope_confirmed;
      const paymentIsolationPayments = [
        { ...lossPayments[0], payment_id: "isolation-loss-a", withheld_amount: "0" },
        { ...actualExpensePayments[0], payment_id: "isolation-nonloss-b", withheld_amount: "66000" },
        isolationMissingScope,
      ];
      const paymentIsolationMatter = calculationMatter(paymentIsolationPayments, calculationDate,
        "live-other-payment-isolation");
      const personalServicePayments = Object.keys(PERSONAL_SERVICE_SUBTYPES).map((serviceSubtype) =>
        personalServicePayment(serviceSubtype, 1000000, `personal-${serviceSubtype}`, calculationDate));
      personalServicePayments.push(personalServicePayment("translation", 33333,
        "personal-translation-33333", calculationDate));
      personalServicePayments.at(-1).withheld_amount = "990";
      const personalServiceMatter = calculationMatter(personalServicePayments, calculationDate,
        "live-personal-service");
      const personalBoundaryMatter = calculationMatter([
        personalServicePayment("translation", 10000, "personal-translation-10000", calculationDate),
        personalServicePayment("translation", 333, "personal-translation-333", calculationDate),
        personalServicePayment("translation", 334, "personal-translation-334", calculationDate),
      ], calculationDate, "live-personal-service-boundaries");
      const retryBudget = { used: 0 };
      const businessPlan = await planWithBoundedBudgetRetries(call, businessMatter, retryBudget,
        ["business-33333", "business-10000"]);
      const otherPlan = await planWithBoundedBudgetRetries(call, otherMatter, retryBudget,
        ["other-125000", "other-125001", "other-1000000"]);
      const otherPersonalPlan = await planWithBoundedBudgetRetries(call, otherPersonalMatter, retryBudget,
        otherPersonalPayments.map((item) => item.payment_id));
      const actualExpensePlan = await planWithBoundedBudgetRetries(call, actualExpenseMatter, retryBudget,
        actualExpensePayments.map((item) => item.payment_id));
      const lossPlan = await planWithBoundedBudgetRetries(call, lossMatter, retryBudget,
        lossPayments.map((item) => item.payment_id));
      const paymentIsolationPlan = await planWithBoundedBudgetRetries(call, paymentIsolationMatter, retryBudget,
        paymentIsolationPayments.map((item) => item.payment_id));
      const actualExpensePractitionerAnswers = {};
      for (const [label, paymentId] of [
        ["lecture", "other-actual-lecture-1000000"],
        ["service", "other-actual-service-advisory-1000000"],
        ["threshold", "other-actual-boundary-50000"],
      ]) {
        const payment = actualExpensePayments.find((item) => item.payment_id === paymentId);
        must(payment, `Actual-expense practitioner scenario is missing ${paymentId}`);
        actualExpensePractitionerAnswers[label] = await call("tax_answer_practitioner_question", {
          matter: calculationMatter([payment], calculationDate, `live-actual-practitioner-${paymentId}`),
          include_evidence: true,
        });
      }
      const lossPractitionerAnswers = {};
      for (const [label, paymentId] of [["lecture", "loss-other-lecture"], ["manuscript", "loss-other-manuscript"]]) {
        const payment = lossPayments.find((item) => item.payment_id === paymentId);
        must(payment, `Loss practitioner scenario is missing ${paymentId}`);
        lossPractitionerAnswers[label] = await call("tax_answer_practitioner_question", {
          matter: calculationMatter([payment], calculationDate, `live-loss-practitioner-${paymentId}`),
          include_evidence: true,
        });
      }
      const paymentIsolationAnswer = await call("tax_answer_practitioner_question", {
        matter: calculationMatter(paymentIsolationPayments.slice(0, 2), calculationDate,
          "live-other-payment-isolation-practitioner"), include_evidence: true,
      });
      const personalServicePlan = await planWithBoundedBudgetRetries(call, personalServiceMatter, retryBudget,
        [...personalServicePayments.map((item) => item.payment_id)]);
      const personalBoundaryPlan = await planWithBoundedBudgetRetries(call, personalBoundaryMatter, retryBudget,
        ["personal-translation-10000", "personal-translation-333", "personal-translation-334"]);
      equivalent(businessPlan.result.withholding_calculations.map((row) => row.payment_id),
        ["business-33333", "business-10000"], "Business calculation rows must preserve payment input order");
      equivalent(otherPlan.result.withholding_calculations.map((row) => row.payment_id),
        ["other-125000", "other-125001", "other-1000000"], "Other calculation rows must preserve payment input order");
      equivalent(otherPersonalPlan.result.withholding_calculations.map((row) => row.payment_id),
        otherPersonalPayments.map((item) => item.payment_id),
        "Other-personal-service calculation rows must preserve payment input order");
      equivalent(personalServicePlan.result.withholding_calculations.map((row) => row.payment_id),
        personalServicePayments.map((item) => item.payment_id),
        "Personal-service calculation rows must preserve payment input order");
      equivalent(personalBoundaryPlan.result.withholding_calculations.map((row) => row.payment_id),
        ["personal-translation-10000", "personal-translation-333", "personal-translation-334"],
        "Personal-service boundary rows must preserve payment input order");
      same(businessPlan.result.applicability, "not_determined", "Scoped business results must not decide whole-matter applicability");
      same(otherPlan.result.applicability, "not_determined", "Scoped other results must not decide whole-matter applicability");
      same(otherPersonalPlan.result.applicability, "not_determined",
        "Scoped other-personal-service results must not decide whole-matter applicability");
      same(personalServicePlan.result.applicability, "not_determined",
        "Scoped personal-service results must not decide whole-matter applicability");
      same(businessPlan.result.calculation_status, "computed", "Both business lecture payments must compute");
      same(otherPlan.result.calculation_status, "computed", "Both taxable and below-minimum other lecture payments must compute");
      same(otherPersonalPlan.result.calculation_status, "computed",
        "All six bounded temporary other-personal-service payments must compute");
      same(personalServicePlan.result.calculation_status, "computed",
        "All ten personal-service subtypes and the translation boundary payment must compute");
      same(personalBoundaryPlan.result.calculation_status, "computed",
        "Small translation payments must compute without an other-income minimum");
      const business33333 = assertComputedRow(businessPlan.result, "business-33333", {
        profile: "business_lecture", applicability: "applies",
        values: {
          gross_amount: "33333", expense_rate: null, expense_amount: null, income_amount: "33333", tax_base: "33333",
          national_rate: "0.03", national_tax: "990", local_rate: "0.1", local_tax: "90",
          total_withholding: "1080", net_payment: "32253",
        },
      });
      const business10000 = assertComputedRow(businessPlan.result, "business-10000", {
        profile: "business_lecture", applicability: "applies",
        values: {
          gross_amount: "10000", expense_rate: null, expense_amount: null, income_amount: "10000", tax_base: "10000",
          national_rate: "0.03", national_tax: "300", local_rate: "0.1", local_tax: "30",
          total_withholding: "330", net_payment: "9670",
        },
      });
      same(business33333.withholding_required, true, "Business applicability remains applies when national withholding is due");
      same(business10000.withholding_required, true, "Small business payments do not receive a de-minimis waiver");
      const confirmedPayments = businessPlan.result.confirmed_facts.find((fact) => fact.key === "payments")?.value ?? [];
      same(confirmedPayments.find((item) => item.payment_id === "business-33333")?.withheld_amount, "1000",
        "A supplied actual withholding amount must remain unchanged beside the calculation");
      must(/0\.03|3\s*%|3\s*퍼센트/u.test(business33333.formula) &&
        /0\.1|10\s*%|10\s*퍼센트/u.test(business33333.formula),
      "Business formula must state the national 3% and local 10% calculations");
      assertMatchedBasis(businessPlan.result, calculationDate, "business_lecture", businessMatter.facts.payments);

      const personalSubtypeRows = new Map();
      for (const [serviceSubtype, metadata] of Object.entries(PERSONAL_SERVICE_SUBTYPES)) {
        const paymentId = `personal-${serviceSubtype}`;
        const row = assertComputedRow(personalServicePlan.result, paymentId, {
          profile: "business_personal_service", serviceSubtype, applicability: "applies",
          values: {
            gross_amount: "1000000", expense_rate: null, expense_amount: null,
            income_amount: "1000000", tax_base: "1000000", national_rate: "0.03", national_tax: "30000",
            local_rate: "0.1", local_tax: "3000", total_withholding: "33000", net_payment: "967000",
          },
        });
        same(row.withholding_required, true, `${serviceSubtype} must retain the business withholding result`);
        must(/0\.03|3\s*%|3\s*퍼센트/u.test(row.formula) && /0\.1|10\s*%|10\s*퍼센트/u.test(row.formula),
          `${serviceSubtype} formula must explain the national 3% and local 10% calculations`);
        must(metadata.label.length > 0, `${serviceSubtype} must have a public Korean service label`);
        personalSubtypeRows.set(serviceSubtype, row);
      }
      const personalTranslation33333 = assertComputedRow(personalServicePlan.result, "personal-translation-33333", {
        profile: "business_personal_service", serviceSubtype: "translation", applicability: "applies",
        values: {
          gross_amount: "33333", expense_rate: null, expense_amount: null, income_amount: "33333", tax_base: "33333",
          national_rate: "0.03", national_tax: "990", local_rate: "0.1", local_tax: "90",
          total_withholding: "1080", net_payment: "32253",
        },
      });
      same(personalTranslation33333.withholding_required, true,
        "A continuing translation payment does not receive the other-income minimum");
      const personalConfirmedPayments = personalServicePlan.result.confirmed_facts
        .find((fact) => fact.key === "payments")?.value ?? [];
      same(personalConfirmedPayments.find((item) => item.payment_id === "personal-translation-33333")?.service_subtype,
        "translation", "Confirmed facts must preserve the selected subtype");
      same(personalConfirmedPayments.find((item) => item.payment_id === "personal-translation-33333")?.withheld_amount,
        "990", "A supplied actual withholding amount must remain unchanged beside the personal-service calculation");
      assertMatchedBasis(personalServicePlan.result, calculationDate, "business_personal_service",
        personalServiceMatter.facts.payments);

      const personalTranslation10000 = assertComputedRow(personalBoundaryPlan.result, "personal-translation-10000", {
        profile: "business_personal_service", serviceSubtype: "translation", applicability: "applies",
        values: {
          gross_amount: "10000", expense_rate: null, expense_amount: null, income_amount: "10000", tax_base: "10000",
          national_rate: "0.03", national_tax: "300", local_rate: "0.1", local_tax: "30",
          total_withholding: "330", net_payment: "9670",
        },
      });
      same(personalTranslation10000.withholding_required, true,
        "A personal-service national amount below 1,000 won must not receive a waiver");
      const personalTranslation333 = assertComputedRow(personalBoundaryPlan.result, "personal-translation-333", {
        profile: "business_personal_service", serviceSubtype: "translation", applicability: "applies",
        values: {
          gross_amount: "333", expense_rate: null, expense_amount: null, income_amount: "333", tax_base: "333",
          national_rate: "0.03", national_tax: "0", local_rate: "0.1", local_tax: "0",
          total_withholding: "0", net_payment: "333",
        },
      });
      same(personalTranslation333.withholding_required, false,
        "A zero rounded tax amount does not require withholding");
      must(personalTranslation333.reason_codes.includes("rounded_tax_zero"),
        "A zero rounded tax amount must expose its reason code while applicability remains applies");
      const personalTranslation334 = assertComputedRow(personalBoundaryPlan.result, "personal-translation-334", {
        profile: "business_personal_service", serviceSubtype: "translation", applicability: "applies",
        values: {
          gross_amount: "334", expense_rate: null, expense_amount: null, income_amount: "334", tax_base: "334",
          national_rate: "0.03", national_tax: "10", local_rate: "0.1", local_tax: "0",
          total_withholding: "10", net_payment: "324",
        },
      });
      same(personalTranslation334.withholding_required, true,
        "A positive national amount after won truncation requires withholding");
      assertMatchedBasis(personalBoundaryPlan.result, calculationDate, "business_personal_service",
        personalBoundaryMatter.facts.payments);

      const other125000 = assertComputedRow(otherPlan.result, "other-125000", {
        profile: "other_lecture", applicability: "below_taxable_minimum",
        values: {
          gross_amount: "125000", expense_rate: "0.6", expense_amount: "75000", income_amount: "50000",
          tax_base: "50000", national_rate: "0.2", national_tax: "0", local_rate: "0.1", local_tax: "0",
          total_withholding: "0", net_payment: "125000",
        },
      });
      const other125001 = assertComputedRow(otherPlan.result, "other-125001", {
        profile: "other_lecture", applicability: "applies",
        values: {
          gross_amount: "125001", expense_rate: "0.6", expense_amount: "75000.6", income_amount: "50000.4",
          tax_base: "50000", national_rate: "0.2", national_tax: "10000", local_rate: "0.1", local_tax: "1000",
          total_withholding: "11000", net_payment: "114001",
        },
      });
      const other1000000 = assertComputedRow(otherPlan.result, "other-1000000", {
        profile: "other_lecture", applicability: "applies",
        values: {
          gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
          tax_base: "400000", national_rate: "0.2", national_tax: "80000", local_rate: "0.1", local_tax: "8000",
          total_withholding: "88000", net_payment: "912000",
        },
      });
      same(other125000.withholding_required, false, "An other-income amount at the 50,000-won threshold is below the taxable minimum");
      same(other125001.withholding_required, true, "An amount above the threshold requires withholding");
      same(other1000000.withholding_required, true, "Larger other lecture payments require withholding");
      must(/0\.6|60\s*%|60\s*퍼센트/u.test(other125001.formula) &&
        /50000|50,000|5\s*만/u.test(other125001.formula) &&
        /0\.2|20\s*%|20\s*퍼센트/u.test(other125001.formula) &&
        /0\.1|10\s*%|10\s*퍼센트/u.test(other125001.formula),
      "Other formula must explain the 60% allowance, 50,000-won threshold, and national/local rates");
      assertMatchedBasis(otherPlan.result, calculationDate, "other_lecture", otherMatter.facts.payments);

      same(actualExpensePlan.result.calculation_status, "computed",
        "All four supported OTHER profiles and five actual-expense boundary cases must compute");
      equivalent(actualExpensePlan.result.withholding_calculations.map((row) => row.payment_id),
        actualExpensePayments.map((item) => item.payment_id),
        "Actual-expense calculation rows must preserve payment input order");
      const actualExpenseExpectations = [
        { paymentId: "other-actual-lecture-1000000", profile: "other_lecture", amount: "700000",
          applicability: "applies", national: "60000", local: "6000", total: "66000", net: "934000",
          values: { gross_amount: "1000000", expense_rate: null, expense_amount: "700000", income_amount: "300000",
            tax_base: "300000", national_rate: "0.2", national_tax: "60000", local_rate: "0.1", local_tax: "6000",
            total_withholding: "66000", net_payment: "934000" } },
        { paymentId: "other-actual-service-manuscript-1000000", profile: "other_personal_service",
          subtype: "manuscript_fee", amount: "700000", applicability: "applies", national: "60000", local: "6000",
          total: "66000", net: "934000", values: { gross_amount: "1000000", expense_rate: null,
            expense_amount: "700000", income_amount: "300000", tax_base: "300000", national_rate: "0.2",
            national_tax: "60000", local_rate: "0.1", local_tax: "6000", total_withholding: "66000", net_payment: "934000" } },
        { paymentId: "other-actual-service-advisory-1000000", profile: "other_personal_service",
          subtype: "expert_advisory", amount: "700000", applicability: "applies", national: "60000", local: "6000",
          total: "66000", net: "934000", values: { gross_amount: "1000000", expense_rate: null,
            expense_amount: "700000", income_amount: "300000", tax_base: "300000", national_rate: "0.2",
            national_tax: "60000", local_rate: "0.1", local_tax: "6000", total_withholding: "66000", net_payment: "934000" } },
        { paymentId: "other-actual-service-broadcast-1000000", profile: "other_personal_service",
          subtype: "broadcast_commentary", amount: "700000", applicability: "applies", national: "60000", local: "6000",
          total: "66000", net: "934000", values: { gross_amount: "1000000", expense_rate: null,
            expense_amount: "700000", income_amount: "300000", tax_base: "300000", national_rate: "0.2",
            national_tax: "60000", local_rate: "0.1", local_tax: "6000", total_withholding: "66000", net_payment: "934000" } },
        { paymentId: "other-actual-boundary-50000", profile: "other_lecture", amount: "150000",
          applicability: "below_taxable_minimum", national: "0", local: "0", total: "0", net: "200000",
          values: { gross_amount: "200000", expense_rate: null, expense_amount: "150000", income_amount: "50000",
            tax_base: "50000", national_rate: "0.2", national_tax: "0", local_rate: "0.1", local_tax: "0",
            total_withholding: "0", net_payment: "200000" } },
        { paymentId: "other-actual-boundary-50001", profile: "other_personal_service", subtype: "manuscript_fee",
          amount: "149999", applicability: "applies", national: "10000", local: "1000", total: "11000", net: "189000",
          values: { gross_amount: "200000", expense_rate: null, expense_amount: "149999", income_amount: "50001",
            tax_base: "50001", national_rate: "0.2", national_tax: "10000", local_rate: "0.1", local_tax: "1000",
            total_withholding: "11000", net_payment: "189000" } },
        { paymentId: "other-actual-boundary-600001", profile: "other_personal_service", subtype: "expert_advisory",
          amount: "600001", applicability: "applies", national: "79990", local: "7990", total: "87980", net: "912020",
          values: { gross_amount: "1000000", expense_rate: null, expense_amount: "600001", income_amount: "399999",
            tax_base: "399999", national_rate: "0.2", national_tax: "79990", local_rate: "0.1", local_tax: "7990",
            total_withholding: "87980", net_payment: "912020" } },
        { paymentId: "other-actual-boundary-odd-gross", profile: "other_personal_service",
          subtype: "broadcast_commentary", amount: "700000", applicability: "applies", national: "60020", local: "6000",
          total: "66020", net: "934103", values: { gross_amount: "1000123", expense_rate: null,
            expense_amount: "700000", income_amount: "300123", tax_base: "300123", national_rate: "0.2",
            national_tax: "60020", local_rate: "0.1", local_tax: "6000", total_withholding: "66020", net_payment: "934103" } },
        { paymentId: "other-actual-boundary-full-gross", profile: "other_lecture", amount: "1000000",
          applicability: "below_taxable_minimum", national: "0", local: "0", total: "0", net: "1000000",
          values: { gross_amount: "1000000", expense_rate: null, expense_amount: "1000000", income_amount: "0",
            tax_base: "0", national_rate: "0.2", national_tax: "0", local_rate: "0.1", local_tax: "0",
            total_withholding: "0", net_payment: "1000000" } },
      ];
      const actualExpenseRows = new Map();
      for (const expected of actualExpenseExpectations) {
        const row = assertComputedRow(actualExpensePlan.result, expected.paymentId, {
          profile: expected.profile, otherServiceSubtype: expected.subtype, expenseMethod: "actual",
          applicability: expected.applicability, values: expected.values,
        });
        same(row.withholding_required, expected.applicability === "applies",
          `${expected.paymentId} must apply the taxable-minimum threshold to actual-expense income`);
        must(row.formula.includes(expected.amount), `${expected.paymentId} formula must state the entered expense total`);
        actualExpenseRows.set(expected.paymentId, row);
      }
      const confirmedActualPayments = actualExpensePlan.result.confirmed_facts.find((fact) => fact.key === "payments")?.value ?? [];
      for (const payment of actualExpensePayments) {
        const confirmed = confirmedActualPayments.find((item) => item.payment_id === payment.payment_id);
        same(confirmed?.actual_expense_amount, String(payment.actual_expense_amount),
          `${payment.payment_id} must retain the user-supplied expense total`);
        same(confirmed?.actual_expense_scope_confirmed, true,
          `${payment.payment_id} must retain the unverified scope assertion`);
      }
      const actualExpenseRowsArray = [...actualExpenseRows.values()];
      assertMatchedBasis({ ...actualExpensePlan.result, withholding_calculations:
        actualExpenseRowsArray.filter((row) => row.profile === "other_lecture") },
      calculationDate, "other_lecture", actualExpensePayments);
      assertMatchedBasis({ ...actualExpensePlan.result, withholding_calculations:
        actualExpenseRowsArray.filter((row) => row.profile === "other_personal_service") },
      calculationDate, "other_personal_service", actualExpensePayments);

      same(lossPlan.result.calculation_status, "computed",
        "All seven above-gross OTHER cases must compute with the complete supported fact and evidence set");
      equivalent(lossPlan.result.withholding_calculations.map((row) => row.payment_id),
        lossPayments.map((item) => item.payment_id), "Loss calculation rows must preserve payment input order");
      const lossExpectations = [
        { paymentId: "loss-other-lecture", profile: "other_lecture", amount: "1200000", excess: "200000",
          gross: "1000000", income: "-200000", net: "1000000" },
        { paymentId: "loss-other-manuscript", profile: "other_personal_service", subtype: "manuscript_fee",
          amount: "1200000", excess: "200000", gross: "1000000", income: "-200000", net: "1000000" },
        { paymentId: "loss-other-advisory", profile: "other_personal_service", subtype: "expert_advisory",
          amount: "1200000", excess: "200000", gross: "1000000", income: "-200000", net: "1000000" },
        { paymentId: "loss-other-broadcast", profile: "other_personal_service", subtype: "broadcast_commentary",
          amount: "1200000", excess: "200000", gross: "1000000", income: "-200000", net: "1000000" },
        { paymentId: "loss-one-won-excess", profile: "other_lecture", amount: "1000001", excess: "1",
          gross: "1000000", income: "-1", net: "1000000" },
        { paymentId: "loss-zero-gross", profile: "other_personal_service", subtype: "manuscript_fee",
          amount: "1", excess: "1", gross: "0", income: "-1", net: "0" },
        { paymentId: "loss-odd-gross", profile: "other_personal_service", subtype: "broadcast_commentary",
          amount: "1000124", excess: "1", gross: "1000123", income: "-1", net: "1000123" },
      ].map((expected) => {
        const { gross, income, net } = expected;
        return {
          ...expected, gross, income, net,
          values: { gross_amount: gross, expense_rate: null, expense_amount: expected.amount,
            income_amount: income, tax_base: "0", national_rate: "0.2", national_tax: "0",
            local_rate: "0.1", local_tax: "0", total_withholding: "0", net_payment: net },
        };
      });
      const lossRows = new Map();
      for (const expected of lossExpectations) {
        const row = assertComputedRow(lossPlan.result, expected.paymentId, {
          profile: expected.profile, otherServiceSubtype: expected.subtype, expenseMethod: "actual",
          applicability: "below_taxable_minimum", lossScope: true,
          expenseExcessAmount: expected.excess, values: expected.values,
        });
        same(row.withholding_required, false, `${expected.paymentId} must not withhold on a negative payment difference`);
        equivalent(row.reason_codes, ["below_taxable_minimum", "actual_expenses_exceed_gross"],
          `${expected.paymentId} must carry the exact below-minimum and positive-excess reasons`);
        must(row.formula.includes(`${expected.gross} − ${expected.amount} = ${expected.income}원`) &&
          row.formula.includes(`지급액 초과 필요경비는 ${expected.excess}원`) &&
          row.formula.includes("비음수 원천징수 계산용 과세표준은 0원") &&
          row.formula.includes("연간 기타소득 합산·다른 소득 상계·결손금 이월·환급은 계산하지 않습니다"),
        `${expected.paymentId} formula must preserve signed payment arithmetic and the annual-calculation boundary`);
        lossRows.set(expected.paymentId, row);
      }
      const lossRowsArray = [...lossRows.values()];
      assertMatchedBasis({ ...lossPlan.result, withholding_calculations:
        lossRowsArray.filter((row) => row.profile === "other_lecture") },
      calculationDate, "other_lecture", lossPayments);
      assertMatchedBasis({ ...lossPlan.result, withholding_calculations:
        lossRowsArray.filter((row) => row.profile === "other_personal_service") },
      calculationDate, "other_personal_service", lossPayments);

      same(paymentIsolationPlan.result.calculation_status, "partial",
        "Mixed computed and missing-fact rows must preserve partial calculation status");
      same(paymentIsolationPlan.result.status, "needs_facts",
        "A missing scope assertion must leave the matter waiting for facts");
      equivalent(paymentIsolationPlan.result.withholding_calculations.map((row) => row.payment_id),
        paymentIsolationPayments.map((item) => item.payment_id),
        "Mixed loss and nonloss rows must preserve payment input order");
      const isolationLoss = assertComputedRow(paymentIsolationPlan.result, "isolation-loss-a", {
        profile: "other_lecture", expenseMethod: "actual", applicability: "below_taxable_minimum",
        lossScope: true, expenseExcessAmount: "200000",
        values: { gross_amount: "1000000", expense_rate: null, expense_amount: "1200000",
          income_amount: "-200000", tax_base: "0", national_rate: "0.2", national_tax: "0",
          local_rate: "0.1", local_tax: "0", total_withholding: "0", net_payment: "1000000" },
      });
      same(isolationLoss.withholding_required, false, "A loss row must keep its own zero-withholding result");
      const isolationNonloss = assertComputedRow(paymentIsolationPlan.result, "isolation-nonloss-b", {
        profile: "other_lecture", expenseMethod: "actual", applicability: "applies",
        values: { gross_amount: "1000000", expense_rate: null, expense_amount: "700000",
          income_amount: "300000", tax_base: "300000", national_rate: "0.2", national_tax: "60000",
          local_rate: "0.1", local_tax: "6000", total_withholding: "66000", net_payment: "934000" },
      });
      same(isolationNonloss.withholding_required, true,
        "The separate positive payment must retain its ordinary withholding result");
      assertNoCalculatedAmounts(paymentIsolationPlan.result, ["isolation-missing-scope"],
        "The missing-scope payment must not receive signed or excess amounts");
      const isolationMissingScopeRow = paymentIsolationPlan.result.withholding_calculations.find((row) =>
        row.payment_id === "isolation-missing-scope");
      same(isolationMissingScopeRow.status, "needs_facts",
        "The above-gross mixed payment must remain blocked until its scope is confirmed");
      must(isolationMissingScopeRow.missing_facts.includes("actual_expense_scope_confirmed") &&
        isolationMissingScopeRow.rule_ids.includes("WH-CALC-OTHER-LOSS-SCOPE"),
      "The mixed missing-scope row must request scope while retaining its conditional loss basis");
      assertMatchedBasis({ ...paymentIsolationPlan.result, withholding_calculations: [isolationLoss] },
        calculationDate, "other_lecture", paymentIsolationPayments);
      assertMatchedBasis({ ...paymentIsolationPlan.result, withholding_calculations: [isolationNonloss] },
        calculationDate, "other_lecture", paymentIsolationPayments);

      for (const expected of [
        { label: "lecture", paymentId: "other-actual-lecture-1000000", profile: "other_lecture",
          national: "60000", local: "6000", total: "66000", net: "934000", actualWithheld: "60000원",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "matches_national_tax",
          values: actualExpenseExpectations[0].values,
          nationalExpression: /10원 단위 절사\(300000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(60000\s*×\s*0\.1\)/u },
        { label: "service", paymentId: "other-actual-service-advisory-1000000", profile: "other_personal_service",
          subtype: "expert_advisory", national: "60000", local: "6000", total: "66000", net: "934000",
          actualWithheld: "66000원", comparisonOutcome: "comparison_true_candidate",
          comparisonStatus: "differs_from_national_tax", values: actualExpenseExpectations[2].values,
          nationalExpression: /10원 단위 절사\(300000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(60000\s*×\s*0\.1\)/u },
        { label: "threshold", paymentId: "other-actual-boundary-50000", profile: "other_lecture",
          national: "0", local: "0", total: "0", net: "200000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_false_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: actualExpenseExpectations[4].values,
          nationalExpression: /소득금액\s*50000원\s*≤\s*50,000원\s*과세최저한\s*→\s*0원/u,
          localExpression: /10원 단위 절사\(0\s*×\s*0\.1\)/u },
      ]) {
        const answer = actualExpensePractitionerAnswers[expected.label];
        same(answer.final_decision, "not_issued", `${expected.paymentId} practitioner answer must remain a draft`);
        same(answer.applicability, "not_determined", `${expected.paymentId} answer must preserve matter-level applicability`);
        const row = actualExpenseRows.get(expected.paymentId);
        must(row, `${expected.paymentId} must have a matched actual-expense calculation row`);
        const subtype = expected.subtype ? OTHER_PERSONAL_SERVICE_SUBTYPES[expected.subtype] : null;
        const practitionerExpected = {
          ...expected,
          expenseMethod: "actual",
          otherServiceSubtype: expected.subtype,
          otherServiceSubtypeLabel: subtype?.label,
          applicability: expected.paymentId === "other-actual-boundary-50000" ? "below_taxable_minimum" : "applies",
          formula: row.formula,
          nationalRate: "0.2",
          localRate: "0.1",
        };
        assertTypedPaymentAssessments(answer, practitionerExpected);
        assertPractitionerCalculationSection(answer, practitionerExpected);
        assertPractitionerBasisProjection(answer, { ...actualExpensePlan.result,
          withholding_calculations: [row] }, [expected.paymentId]);
      }

      for (const expected of [
        { label: "lecture", paymentId: "loss-other-lecture", profile: "other_lecture",
          national: "0", local: "0", total: "0", net: "1000000", actualWithheld: "0원",
          comparisonOutcome: "comparison_false_candidate", comparisonStatus: "matches_national_tax",
          expenseExcessAmount: "200000", values: lossExpectations[0].values },
        { label: "manuscript", paymentId: "loss-other-manuscript", profile: "other_personal_service",
          otherServiceSubtype: "manuscript_fee", national: "0", local: "0", total: "0", net: "1000000",
          actualWithheld: "66000원", comparisonOutcome: "comparison_false_candidate",
          comparisonStatus: "differs_from_national_tax", expenseExcessAmount: "200000",
          values: lossExpectations[1].values },
      ]) {
        const answer = lossPractitionerAnswers[expected.label];
        same(answer.final_decision, "not_issued", `${expected.paymentId} practitioner answer must remain a draft`);
        same(answer.applicability, "not_determined", `${expected.paymentId} answer must preserve matter-level applicability`);
        const row = lossRows.get(expected.paymentId);
        must(row, `${expected.paymentId} must have a matched negative-income calculation row`);
        const subtype = expected.otherServiceSubtype ? OTHER_PERSONAL_SERVICE_SUBTYPES[expected.otherServiceSubtype] : null;
        const practitionerExpected = {
          ...expected,
          expenseMethod: "actual",
          lossScope: true,
          otherServiceSubtypeLabel: subtype?.label,
          applicability: "below_taxable_minimum",
          formula: row.formula,
          nationalRate: "0.2",
          localRate: "0.1",
          nationalExpression: /원천징수 계산용 과세표준\s*0원.*50,000원\s*이하.*→\s*0원/u,
          localExpression: /10원 단위 절사\(0\s*×\s*0\.1\)/u,
        };
        assertTypedPaymentAssessments(answer, practitionerExpected);
        assertPractitionerCalculationSection(answer, practitionerExpected);
        assertPractitionerBasisProjection(answer, { ...lossPlan.result, withholding_calculations: [row] },
          [expected.paymentId]);
        const sources = answer.perspective_view?.sections?.source_evidence ?? [];
        for (const article of ["제21조", "제45조"]) {
          must(sources.some((item) => typeof item.text === "string" && item.text.includes(article) &&
            item.text.includes("fetched_text_not_compared")),
          `${expected.paymentId} practitioner source section must retain fetched ${article} evidence`);
        }
      }

      same(paymentIsolationAnswer.final_decision, "not_issued",
        "The mixed-payment practitioner answer must remain a draft");
      same(paymentIsolationAnswer.applicability, "not_determined",
        "The mixed-payment answer must preserve matter-level applicability");
      for (const expected of [
        { paymentId: "isolation-loss-a", profile: "other_lecture", lossScope: true,
          expenseExcessAmount: "200000", national: "0", local: "0", total: "0", net: "1000000",
          actualWithheld: "0원", comparisonOutcome: "comparison_false_candidate",
          comparisonStatus: "matches_national_tax", applicability: "below_taxable_minimum",
          values: { gross_amount: "1000000", expense_rate: null, expense_amount: "1200000",
            income_amount: "-200000", tax_base: "0", national_rate: "0.2", national_tax: "0",
            local_rate: "0.1", local_tax: "0", total_withholding: "0", net_payment: "1000000" } },
        { paymentId: "isolation-nonloss-b", profile: "other_lecture", expenseExcessAmount: "0",
          national: "60000", local: "6000", total: "66000", net: "934000", actualWithheld: "66000원",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "differs_from_national_tax",
          applicability: "applies",
          values: { gross_amount: "1000000", expense_rate: null, expense_amount: "700000",
            income_amount: "300000", tax_base: "300000", national_rate: "0.2", national_tax: "60000",
            local_rate: "0.1", local_tax: "6000", total_withholding: "66000", net_payment: "934000" } },
      ]) {
        const row = paymentIsolationPlan.result.withholding_calculations.find((item) =>
          item.payment_id === expected.paymentId);
        must(row, `${expected.paymentId} must have an independent mixed-payment calculation row`);
        const practitionerExpected = {
          ...expected,
          expenseMethod: "actual",
          formula: row.formula,
          nationalRate: "0.2",
          localRate: "0.1",
          nationalExpression: expected.lossScope
            ? /원천징수 계산용 과세표준\s*0원.*50,000원\s*이하.*→\s*0원/u
            : /10원 단위 절사\(300000\s*×\s*0\.2\)/u,
          localExpression: expected.lossScope
            ? /10원 단위 절사\(0\s*×\s*0\.1\)/u
            : /10원 단위 절사\(60000\s*×\s*0\.1\)/u,
        };
        assertTypedPaymentAssessments(paymentIsolationAnswer, practitionerExpected);
        assertPractitionerCalculationSection(paymentIsolationAnswer, practitionerExpected);
      }
      assertPractitionerBasisProjection(paymentIsolationAnswer, paymentIsolationPlan.result);

      const otherPersonalRows = new Map();
      for (const expected of [
        { paymentId: "other-service-manuscript-1000000", subtype: "manuscript_fee", applicability: "applies",
          values: { gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
            tax_base: "400000", national_rate: "0.2", national_tax: "80000", local_rate: "0.1", local_tax: "8000",
            total_withholding: "88000", net_payment: "912000" } },
        { paymentId: "other-service-advisory-1000000", subtype: "expert_advisory", applicability: "applies",
          values: { gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
            tax_base: "400000", national_rate: "0.2", national_tax: "80000", local_rate: "0.1", local_tax: "8000",
            total_withholding: "88000", net_payment: "912000" } },
        { paymentId: "other-service-broadcast-1000000", subtype: "broadcast_commentary", applicability: "applies",
          values: { gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
            tax_base: "400000", national_rate: "0.2", national_tax: "80000", local_rate: "0.1", local_tax: "8000",
            total_withholding: "88000", net_payment: "912000" } },
        { paymentId: "other-service-manuscript-125000", subtype: "manuscript_fee", applicability: "below_taxable_minimum",
          values: { gross_amount: "125000", expense_rate: "0.6", expense_amount: "75000", income_amount: "50000",
            tax_base: "50000", national_rate: "0.2", national_tax: "0", local_rate: "0.1", local_tax: "0",
            total_withholding: "0", net_payment: "125000" } },
        { paymentId: "other-service-advisory-125001", subtype: "expert_advisory", applicability: "applies",
          values: { gross_amount: "125001", expense_rate: "0.6", expense_amount: "75000.6", income_amount: "50000.4",
            tax_base: "50000", national_rate: "0.2", national_tax: "10000", local_rate: "0.1", local_tax: "1000",
            total_withholding: "11000", net_payment: "114001" } },
        { paymentId: "other-service-broadcast-1000123", subtype: "broadcast_commentary", applicability: "applies",
          values: { gross_amount: "1000123", expense_rate: "0.6", expense_amount: "600073.8", income_amount: "400049.2",
            tax_base: "400049", national_rate: "0.2", national_tax: "80000", local_rate: "0.1", local_tax: "8000",
            total_withholding: "88000", net_payment: "912123" } },
      ]) {
        const row = assertComputedRow(otherPersonalPlan.result, expected.paymentId, {
          profile: "other_personal_service", otherServiceSubtype: expected.subtype,
          applicability: expected.applicability, values: expected.values,
        });
        same(row.withholding_required, expected.applicability === "applies",
          `${expected.paymentId} must apply the other-income threshold independently of the profile label`);
        must(/0\.6|60\s*%|60\s*퍼센트/u.test(row.formula) &&
          /0\.2|20\s*%|20\s*퍼센트/u.test(row.formula) &&
          /0\.1|10\s*%|10\s*퍼센트/u.test(row.formula),
        `${expected.paymentId} formula must show the standard expense and national/local rates`);
        otherPersonalRows.set(expected.paymentId, row);
      }
      const confirmedOtherPayments = otherPersonalPlan.result.confirmed_facts.find((fact) => fact.key === "payments")?.value ?? [];
      const confirmedManuscript = confirmedOtherPayments.find((item) => item.payment_id === "other-service-manuscript-125000");
      same(confirmedManuscript?.other_service_subtype, "manuscript_fee",
        "Confirmed facts must preserve the selected other-service subtype");
      same(confirmedManuscript?.other_service_scope_confirmed, true,
        "Confirmed facts must preserve the supplied compound scope assertion");
      must(confirmedManuscript?.withheld_amount === undefined || confirmedManuscript?.withheld_amount === null,
        "An absent actual withholding amount must remain absent or null, never derived from calculated tax");
      same(confirmedOtherPayments.find((item) => item.payment_id === "other-service-advisory-125001")?.withheld_amount,
        "10000", "A supplied actual withholding amount must remain unchanged");
      same(confirmedOtherPayments.find((item) => item.payment_id === "other-service-broadcast-1000000")?.withheld_amount,
        "88000", "A supplied total including local tax must remain unchanged for comparison");
      assertMatchedBasis(otherPersonalPlan.result, calculationDate, "other_personal_service",
        otherPersonalMatter.facts.payments);

      const noEvidence = await call("tax_plan_work", { matter: businessMatter, include_evidence: false });
      same(noEvidence.calculation_status, "blocked", "Evidence-disabled selected profiles must aggregate as blocked");
      assertNoCalculatedAmounts(noEvidence, ["business-33333", "business-10000"],
        "Selected lecture profiles require matched current-law evidence");
      for (const row of noEvidence.withholding_calculations) {
        same(row.status, "blocked", "A selected profile without evidence must be blocked");
        must(row.reason_codes.includes("evidence_not_requested"), "Evidence-disabled calculation must report evidence_not_requested");
        must(row.basis_checks.length > 0 && row.basis_checks.every((check) =>
          check.status === "not_requested" && check.reason === "evidence_not_requested" &&
          /^[0-9a-f]{64}$/.test(check.expected_text_sha256) && check.actual_text_sha256 === null &&
          check.retrieved_at === null && check.source_link === null),
        "Evidence-disabled basis rows must report only the pinned expectation");
      }
      const noEvidenceOther = await call("tax_plan_work", { matter: otherMatter, include_evidence: false });
      same(noEvidenceOther.calculation_status, "blocked",
        "Evidence-disabled other lecture profiles must aggregate as blocked");
      assertNoCalculatedAmounts(noEvidenceOther,
        ["other-125000", "other-125001", "other-1000000"],
        "Other lecture profiles require matched current-law evidence");
      const noEvidenceOtherPersonal = await call("tax_plan_work", {
        matter: otherPersonalMatter, include_evidence: false,
      });
      same(noEvidenceOtherPersonal.calculation_status, "blocked",
        "Evidence-disabled other-personal-service profiles must aggregate as blocked");
      assertNoCalculatedAmounts(noEvidenceOtherPersonal, otherPersonalPayments.map((item) => item.payment_id),
        "Other-personal-service profiles require matched current-law evidence");
      const noEvidenceBroadcast = noEvidenceOtherPersonal.withholding_calculations
        .find((row) => row.payment_id === "other-service-broadcast-1000000");
      same(noEvidenceBroadcast.other_service_subtype, "broadcast_commentary",
        "Evidence-disabled rows must echo the selected other-service subtype");
      same(noEvidenceBroadcast.status, "blocked", "Evidence-disabled other-personal-service rows must be blocked");
      must(noEvidenceBroadcast.reason_codes.includes("evidence_not_requested"),
        "Evidence-disabled other-personal-service rows must explain the evidence gate");
      const noEvidenceConfirmedBroadcast = noEvidenceOtherPersonal.confirmed_facts
        .find((fact) => fact.key === "payments")?.value?.find((item) => item.payment_id === "other-service-broadcast-1000000");
      same(noEvidenceConfirmedBroadcast?.other_service_scope_confirmed, true,
        "Evidence-disabled confirmed facts must preserve the supplied scope assertion");
      const noEvidenceActual = await call("tax_plan_work", {
        matter: calculationMatter([actualExpensePayments[0]], calculationDate, "live-no-evidence-actual-expense"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(noEvidenceActual, [actualExpensePayments[0].payment_id],
        "An actual-expense input must not calculate when evidence is disabled");
      const noEvidenceActualRow = noEvidenceActual.withholding_calculations[0];
      same(noEvidenceActualRow.expense_method, "actual", "Evidence-disabled actual selection must retain its method");
      must(noEvidenceActualRow.rule_ids.includes("WH-CALC-OTHER-ACTUAL-SCOPE") &&
        noEvidenceActualRow.rule_ids.includes("WH-CALC-OTHER-ACTUAL-WITHHOLDING") &&
        noEvidenceActualRow.basis_checks.every((check) => check.status === "not_requested"),
      "Evidence-disabled actual rows must retain both selected actual-expense cards without amounts");
      const noEvidenceLoss = await call("tax_plan_work", {
        matter: calculationMatter([lossPayments[0]], calculationDate, "live-no-evidence-loss-scope"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(noEvidenceLoss, [lossPayments[0].payment_id],
        "An above-gross actual-expense input must not calculate without matched evidence");
      const noEvidenceLossRow = noEvidenceLoss.withholding_calculations[0];
      must(noEvidenceLossRow.rule_ids.includes("WH-CALC-OTHER-ACTUAL-SCOPE") &&
        noEvidenceLossRow.rule_ids.includes("WH-CALC-OTHER-ACTUAL-WITHHOLDING") &&
        noEvidenceLossRow.rule_ids.includes("WH-CALC-OTHER-LOSS-SCOPE") &&
        noEvidenceLossRow.basis_checks.every((check) => check.status === "not_requested"),
      "Evidence-disabled loss rows must retain all three selected actual and loss-scope cards without amounts");

      const actualNegativeResults = [];
      const actualFactCase = async (payment, expectedStatus, expectedReason, label) => {
        const result = await call("tax_plan_work", {
          matter: calculationMatter([payment], calculationDate, `live-${label}`), include_evidence: false,
        });
        assertNoCalculatedAmounts(result, [payment.payment_id], `${label} must not calculate`);
        const row = result.withholding_calculations[0];
        same(row.status, expectedStatus, `${label} must retain its expected native status`);
        if (expectedReason) must(row.reason_codes.includes(expectedReason), `${label} must state ${expectedReason}`);
        actualNegativeResults.push(result);
        return { result, row };
      };
      const missingExpenseSelectorPayment = actualExpensePayment("other_lecture", undefined, 1000000, 700000,
        "missing-actual-expense-selector", calculationDate);
      delete missingExpenseSelectorPayment.expenses_exceed_standard;
      const missingExpenseSelector = await actualFactCase(missingExpenseSelectorPayment, "needs_facts",
        "missing_required_facts", "missing-actual-expense-selector");
      must(missingExpenseSelector.row.missing_facts.includes("expenses_exceed_standard") &&
        missingExpenseSelector.row.expense_method === null,
      "New expense facts must defer to the unanswered standard-versus-actual selector");
      const missingBothActualPayment = lecturePayment("other_lecture", 1000000,
        "missing-both-actual-expense-facts", calculationDate);
      missingBothActualPayment.expenses_exceed_standard = true;
      const missingBothActual = await actualFactCase(missingBothActualPayment, "needs_facts",
        "missing_required_facts", "missing-both-actual-expense-facts");
      must(missingBothActual.row.missing_facts.includes("actual_expense_amount") &&
        missingBothActual.row.missing_facts.includes("actual_expense_scope_confirmed"),
      "Actual mode must request both the total amount and compound scope confirmation");
      const actualExpenseQuestions = new Map(missingBothActual.result.questions.map((item) =>
        [item.fact_key, item.text]));
      const actualAmountQuestion = actualExpenseQuestions.get(
        "payments[missing-both-actual-expense-facts].actual_expense_amount");
      must(typeof actualAmountQuestion === "string" && /원 단위 정수/u.test(actualAmountQuestion) &&
        /총수입금액의 60%를 초과/u.test(actualAmountQuestion) &&
        /총수입금액보다 커도/u.test(actualAmountQuestion) &&
        /1,000,000,000,000,000원/u.test(actualAmountQuestion),
      "The amount question must state whole-won entry, the 60% threshold, above-gross support, and the existing ceiling");
      const actualScopeQuestion = actualExpenseQuestions.get(
        "payments[missing-both-actual-expense-facts].actual_expense_scope_confirmed");
      const actualScopeQuestionPatterns = [
        /해당 과세기간 수입에 대응/u,
        /일반적으로 인정되는 통상/u,
        /과거 기간 비용/u,
        /지급자가 대응 금액을 확인할 수/u,
        /소득세법 제37조 제4항·제33조 제1항/u,
        /개인·가사·무관 비용/u,
        /소득세·지방소득세/u,
        /벌금·과태료/u,
        /배분/u, /감가상각/u, /한도/u, /시기 조정/u, /중복 공제/u, /환급/u, /제3자 부담액/u,
        /60%를 초과/u, /총수입금액보다 커도/u, /1,000,000,000,000,000원/u, /기타소득 분류 요건/u,
      ];
      must(typeof actualScopeQuestion === "string" && actualScopeQuestionPatterns.every((pattern) =>
        pattern.test(actualScopeQuestion)),
      "The compound scope question must state the current-period, ordinary, ascertainable, exclusion, unresolved-cost, amount-bound, and existing-classification conditions");
      const missingActualScopePayment = actualExpensePayment("other_lecture", undefined, 1000000, 700000,
        "missing-actual-expense-scope", calculationDate);
      missingActualScopePayment.actual_expense_amount = 1200000;
      delete missingActualScopePayment.actual_expense_scope_confirmed;
      const missingActualScope = await actualFactCase(missingActualScopePayment, "needs_facts",
        "missing_required_facts", "missing-actual-expense-scope");
      must(missingActualScope.row.missing_facts.includes("actual_expense_scope_confirmed"),
        "A missing scope assertion must remain a question");
      must(missingActualScope.row.rule_ids.includes("WH-CALC-OTHER-LOSS-SCOPE"),
        "Known above-gross input must select loss-scope evidence even while scope confirmation is missing");
      const missingActualAmountPayment = actualExpensePayment("other_lecture", undefined, 1000000, 700000,
        "missing-actual-expense-amount", calculationDate);
      delete missingActualAmountPayment.actual_expense_amount;
      const missingActualAmount = await actualFactCase(missingActualAmountPayment, "needs_facts",
        "missing_required_facts", "missing-actual-expense-amount");
      must(missingActualAmount.row.missing_facts.includes("actual_expense_amount"),
        "A missing expense total must remain a question");
      const falseActualScopePayment = actualExpensePayment("other_lecture", undefined, 1000000, 700000,
        "false-actual-expense-scope", calculationDate);
      falseActualScopePayment.actual_expense_amount = 1200000;
      falseActualScopePayment.actual_expense_scope_confirmed = false;
      const falseActualScope = await actualFactCase(falseActualScopePayment, "unsupported",
        "actual_expense_scope_not_confirmed", "false-actual-expense-scope");
      must(falseActualScope.row.rule_ids.includes("WH-CALC-OTHER-LOSS-SCOPE"),
        "Known above-gross input must select loss-scope evidence even while scope confirmation is false");
      const exactStandardExpensePayment = actualExpensePayment("other_lecture", undefined, 1000000, 600000,
        "actual-expense-not-above-standard", calculationDate);
      await actualFactCase(exactStandardExpensePayment, "unsupported",
        "actual_expense_not_above_standard", "actual-expense-not-above-standard");
      const falseSelectorPayment = actualExpensePayment("other_lecture", undefined, 1000000, 700000,
        "standard-selector-with-actual-facts", calculationDate);
      falseSelectorPayment.expenses_exceed_standard = false;
      await actualFactCase(falseSelectorPayment, "unsupported",
        "actual_expense_selection_conflict", "standard-selector-with-actual-facts");
      const actualOnBusinessResults = [];
      for (const [profile, payment] of [
        ["business_lecture", lecturePayment("business_lecture", 1000000, "actual-fields-business-lecture", calculationDate)],
        ["business_personal_service", personalServicePayment("translation", 1000000,
          "actual-fields-business-service", calculationDate)],
      ]) {
        payment.actual_expense_amount = 700000;
        payment.actual_expense_scope_confirmed = true;
        const check = await actualFactCase(payment, "unsupported", "actual_expense_profile_conflict",
          `actual-fields-${profile}`);
        same(check.row.expense_method, null, `${profile} must not select an actual OTHER expense method`);
        actualOnBusinessResults.push(check.result);
      }
      const noEvidencePersonal = await call("tax_plan_work", {
        matter: personalServiceMatter, include_evidence: false,
      });
      same(noEvidencePersonal.calculation_status, "blocked",
        "Evidence-disabled personal-service profiles must aggregate as blocked");
      assertNoCalculatedAmounts(noEvidencePersonal,
        personalServicePayments.map((item) => item.payment_id),
        "Personal-service profiles require matched current-law evidence");
      const noEvidenceTranslation = noEvidencePersonal.withholding_calculations
        .find((row) => row.payment_id === "personal-translation-33333");
      same(noEvidenceTranslation.service_subtype, "translation",
        "Evidence-disabled rows must echo the supplied subtype");
      same(noEvidenceTranslation.status, "blocked", "Evidence-disabled personal-service rows must be blocked");
      must(noEvidenceTranslation.reason_codes.includes("evidence_not_requested"),
        "Evidence-disabled personal-service rows must explain the evidence gate");

      const unknownProfileMatter = calculationMatter([
        { ...lecturePayment("business_lecture", 1000, "unknown-profile", calculationDate), withholding_profile: "unknown" },
      ], calculationDate, "live-unknown-profile");
      const unknownProfile = await call("tax_plan_work", { matter: unknownProfileMatter, include_evidence: false });
      assertNoCalculatedAmounts(unknownProfile, ["unknown-profile"], "An unknown profile must ask for classification");
      const unknownRow = unknownProfile.withholding_calculations[0];
      same(unknownRow.status, "needs_facts", "Unknown profile must request a fact");
      same(unknownRow.reason_codes[0], "profile_required", "Unknown profile must use the scoped reason");
      must(unknownRow.missing_facts.includes("withholding_profile"), "Unknown profile must list the missing profile fact");
      must(unknownProfile.questions.some((item) => item.fact_key === "payments[unknown-profile].withholding_profile"),
        "Unknown profile must ask the exact payment-level profile question");
      const profileQuestion = unknownProfile.questions.find((item) => item.fact_key ===
        "payments[unknown-profile].withholding_profile");
      must(typeof profileQuestion?.text === "string" &&
        ["business_lecture", "business_personal_service", "other_lecture", "other_personal_service"].every((token) =>
          profileQuestion.text.includes(token)),
      "The profile question must enumerate all four bounded calculation profiles");

      const missingSubtypePayment = personalServicePayment("unknown", 1000, "missing-service-subtype", calculationDate);
      delete missingSubtypePayment.service_subtype;
      const missingSubtype = await call("tax_plan_work", {
        matter: calculationMatter([missingSubtypePayment], calculationDate, "live-missing-service-subtype"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(missingSubtype, ["missing-service-subtype"],
        "A missing service subtype must not compute");
      same(missingSubtype.withholding_calculations[0].status, "needs_facts",
        "A missing service subtype must request facts");
      same(missingSubtype.withholding_calculations[0].service_subtype, "unknown",
        "A missing service subtype row must remain explicitly unknown");
      must(missingSubtype.withholding_calculations[0].missing_facts.includes("service_subtype"),
        "The missing-fact list must identify service_subtype");
      must(missingSubtype.questions.some((item) => item.fact_key ===
        "payments[missing-service-subtype].service_subtype"),
      "The missing subtype must create a payment-specific question");

      const unsupportedSubtypePayment = personalServicePayment("unsupported", 1000,
        "unsupported-service-subtype", calculationDate);
      const unsupportedSubtype = await call("tax_plan_work", {
        matter: calculationMatter([unsupportedSubtypePayment], calculationDate, "live-unsupported-service-subtype"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(unsupportedSubtype, ["unsupported-service-subtype"],
        "An explicitly unsupported service subtype must not compute");
      same(unsupportedSubtype.withholding_calculations[0].status, "unsupported",
        "An explicitly unsupported service subtype must remain outside scope");
      same(unsupportedSubtype.withholding_calculations[0].service_subtype, "unsupported",
        "Unsupported subtype rows must echo the user selection");
      must(unsupportedSubtype.withholding_calculations[0].reason_codes.includes("unsupported_service_subtype"),
        "Unsupported subtype rows must identify the scope reason");

      const missingOtherSubtypePayment = otherPersonalServicePayment("manuscript_fee", 1000,
        "missing-other-service-subtype", calculationDate);
      delete missingOtherSubtypePayment.other_service_subtype;
      const missingOtherSubtype = await call("tax_plan_work", {
        matter: calculationMatter([missingOtherSubtypePayment], calculationDate, "live-missing-other-service-subtype"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(missingOtherSubtype, ["missing-other-service-subtype"],
        "A missing other-service subtype must not compute");
      const missingOtherSubtypeRow = missingOtherSubtype.withholding_calculations[0];
      same(missingOtherSubtypeRow.status, "needs_facts", "A missing other-service subtype must request facts");
      same(missingOtherSubtypeRow.other_service_subtype, "unknown",
        "A missing other-service subtype must remain explicitly unknown");
      must(missingOtherSubtypeRow.missing_facts.includes("other_service_subtype"),
        "The missing-fact list must identify other_service_subtype");
      const missingSubtypeQuestion = missingOtherSubtype.questions.find((item) =>
        item.fact_key === "payments[missing-other-service-subtype].other_service_subtype");
      const expectedSubtypeChoices = [
        `manuscript_fee: ${OTHER_PERSONAL_SERVICE_SUBTYPES.manuscript_fee.label}`,
        `expert_advisory: ${OTHER_PERSONAL_SERVICE_SUBTYPES.expert_advisory.label}`,
        `broadcast_commentary: ${OTHER_PERSONAL_SERVICE_SUBTYPES.broadcast_commentary.label}`,
        "unknown: 아직 선택 전",
        "unsupported: 이 목록 외 유형.",
      ];
      const subtypeQuestionPrefix = "실제 지급 유형을 선택해 주세요: ";
      const actualSubtypeChoices = typeof missingSubtypeQuestion?.text === "string" &&
        missingSubtypeQuestion.text.startsWith(subtypeQuestionPrefix)
        ? missingSubtypeQuestion.text.slice(subtypeQuestionPrefix.length).split("; ")
        : null;
      equivalent(actualSubtypeChoices, expectedSubtypeChoices,
        "The subtype question must expose exactly the supported labeled choices and the bounded sentinels");

      const sharedScopePatterns = [
        /이 지급은 이자·배당·사업·근로·연금·퇴직·양도소득에 해당하지 않고/u,
        /이 지급이 일회성이더라도\s*수취인의 전문직 활동이나 계속적인 사업의 수입이 아니며/u,
        /인세·사용료·라이선스료·권리 양도·권리 사용의 대가나/u,
        /그 대가와 분리할 수 없는 혼합 대가가 아님을 확인해 주세요/u,
        /위 조건을 모두 충족합니까\?/u,
      ];
      const scopeCases = [
        { subtype: "manuscript_fee", specifics: [
          /수취인은 문학·학술·미술·음악·사진 분야 창작물의 원작자/u,
          /법령상 해당되는 창작 번역·삽화 포함/u,
          /소득세법 제21조 제1항 제15호 가목의 원고료/u,
          /제15호 나목의 인세나 다목의 창작물 판매·그 밖의 대가가 아닙니다/u,
          /단순 문서 작성·편집·일반 번역 또는 명칭만 원고료인 경우가 아닙니다/u,
        ] },
        { subtype: "expert_advisory", specifics: [
          /전문지식 또는 특별한 기능을 가진 사람이 그 지식·기능을 실제 활용해 특정한 일시적 자문 용역을 제공하고 대가를 받는/u,
          /소득세법 제21조 제1항 제19호 다목의 소득/u,
          /제15호부터 제17호 소득.*포함하지 않습니다/u,
          /전문 자격이나 1회 계약만으로는 충분하지 않습니다/u,
        ] },
        { subtype: "broadcast_commentary", specifics: [
          /라디오·텔레비전 방송 또는 이에 준하는 방송매체를 통해 실제로 일시적 해설·계몽 또는 연기 심사 용역을 제공하고 대가를 받는/u,
          /소득세법 제21조 제1항 제19호 나목의 소득/u,
          /제15호부터 제17호 소득을 포함하지 않습니다/u,
          /일반 위원회 심사·대면 검토·온라인 콘텐츠·공연·자문은 명칭만으로 해당하지 않습니다/u,
        ] },
      ];
      const missingOtherScopeResults = [];
      for (const { subtype, specifics } of scopeCases) {
        const paymentId = `missing-other-service-scope-${subtype}`;
        const payment = otherPersonalServicePayment(subtype, 1000, paymentId, calculationDate);
        delete payment.other_service_scope_confirmed;
        const missingScope = await call("tax_plan_work", {
          matter: calculationMatter([payment], calculationDate, `live-${paymentId}`),
          include_evidence: false,
        });
        assertNoCalculatedAmounts(missingScope, [paymentId],
          "A missing compound scope assertion must not compute");
        const row = missingScope.withholding_calculations[0];
        same(row.status, "needs_facts", "A missing compound scope assertion must request facts");
        must(row.missing_facts.includes("other_service_scope_confirmed"),
          "The missing-fact list must identify the compound scope assertion");
        const question = missingScope.questions.find((item) =>
          item.fact_key === `payments[${paymentId}].other_service_scope_confirmed`);
        const questionText = question?.text ?? "";
        must(typeof question?.text === "string" &&
          [...sharedScopePatterns, ...specifics].every((pattern) => pattern.test(questionText)),
        `${subtype} scope question must state every shared classification condition and its exact statutory scope`);
        missingOtherScopeResults.push(missingScope);
      }

      const unsupportedOtherSubtypePayment = otherPersonalServicePayment("unsupported", 1000,
        "unsupported-other-service-subtype", calculationDate);
      const unsupportedOtherSubtype = await call("tax_plan_work", {
        matter: calculationMatter([unsupportedOtherSubtypePayment], calculationDate, "live-unsupported-other-service-subtype"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(unsupportedOtherSubtype, ["unsupported-other-service-subtype"],
        "An unsupported other-service subtype must not compute");
      same(unsupportedOtherSubtype.withholding_calculations[0].status, "unsupported",
        "An explicitly unsupported other-service subtype must remain outside scope");
      must(unsupportedOtherSubtype.withholding_calculations[0].reason_codes.includes("unsupported_other_service_subtype"),
        "An unsupported other-service subtype must identify the scope reason");

      const falseOtherScopePayment = otherPersonalServicePayment("manuscript_fee", 1000,
        "false-other-service-scope", calculationDate);
      falseOtherScopePayment.other_service_scope_confirmed = false;
      const falseOtherScope = await call("tax_plan_work", {
        matter: calculationMatter([falseOtherScopePayment], calculationDate, "live-false-other-service-scope"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(falseOtherScope, ["false-other-service-scope"],
        "A false compound scope assertion must not compute");
      same(falseOtherScope.withholding_calculations[0].status, "unsupported",
        "A false compound scope assertion must remain unsupported");
      must(falseOtherScope.withholding_calculations[0].reason_codes.includes("other_service_scope_not_confirmed"),
        "A false scope assertion must identify the precise scope reason");

      const otherProfileBusinessSubtype = otherPersonalServicePayment("manuscript_fee", 1000,
        "other-profile-business-subtype", calculationDate);
      otherProfileBusinessSubtype.service_subtype = "translation";
      const otherProfileBusinessSubtypeResult = await call("tax_plan_work", {
        matter: calculationMatter([otherProfileBusinessSubtype], calculationDate, "live-other-profile-business-subtype"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(otherProfileBusinessSubtypeResult, ["other-profile-business-subtype"],
        "A business subtype on the other-service profile must not compute");
      same(otherProfileBusinessSubtypeResult.withholding_calculations[0].status, "unsupported",
        "A cross-family business subtype must remain unsupported");
      must(otherProfileBusinessSubtypeResult.withholding_calculations[0].reason_codes.includes("service_subtype_profile_conflict"),
        "A business subtype on the other-service profile must identify the family conflict");

      const businessProfileOtherSubtype = personalServicePayment("translation", 1000,
        "business-profile-other-subtype", calculationDate);
      businessProfileOtherSubtype.other_service_subtype = "manuscript_fee";
      const businessProfileOtherSubtypeResult = await call("tax_plan_work", {
        matter: calculationMatter([businessProfileOtherSubtype], calculationDate, "live-business-profile-other-subtype"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(businessProfileOtherSubtypeResult, ["business-profile-other-subtype"],
        "An other-service subtype on the business profile must not compute");
      same(businessProfileOtherSubtypeResult.withholding_calculations[0].status, "unsupported",
        "A cross-family other-service subtype must remain unsupported");
      must(businessProfileOtherSubtypeResult.withholding_calculations[0].reason_codes.includes("other_service_subtype_profile_conflict"),
        "An other-service subtype on the business profile must identify the family conflict");

      const businessIncomeOtherService = otherPersonalServicePayment("expert_advisory", 1000,
        "business-income-other-service", calculationDate);
      businessIncomeOtherService.income_type = "business";
      const businessIncomeOtherServiceResult = await call("tax_plan_work", {
        matter: calculationMatter([businessIncomeOtherService], calculationDate, "live-business-income-other-service"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(businessIncomeOtherServiceResult, ["business-income-other-service"],
        "A business-income payment cannot use the temporary other-service profile");
      same(businessIncomeOtherServiceResult.withholding_calculations[0].status, "unsupported",
        "A business-income conflict must remain unsupported");
      must(businessIncomeOtherServiceResult.withholding_calculations[0].reason_codes.includes("income_profile_conflict"),
        "A business-income conflict must use the existing profile conflict reason");

      const continuingOtherService = otherPersonalServicePayment("expert_advisory", 1000,
        "continuing-other-service", calculationDate);
      continuingOtherService.activity_continuity = "continuing";
      const continuingOtherServiceResult = await call("tax_plan_work", {
        matter: calculationMatter([continuingOtherService], calculationDate, "live-continuing-other-service"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(continuingOtherServiceResult, ["continuing-other-service"],
        "A continuing service cannot use the temporary other-service profile");
      same(continuingOtherServiceResult.withholding_calculations[0].status, "unsupported",
        "A continuing-service conflict must remain unsupported");

      const wrongIncomePayment = personalServicePayment("translation", 1000,
        "personal-wrong-income-type", calculationDate);
      wrongIncomePayment.income_type = "other";
      const wrongIncomeType = await call("tax_plan_work", {
        matter: calculationMatter([wrongIncomePayment], calculationDate, "live-personal-wrong-income-type"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(wrongIncomeType, ["personal-wrong-income-type"],
        "A personal-service profile with other income must not compute");
      same(wrongIncomeType.withholding_calculations[0].status, "unsupported",
        "A personal-service profile with conflicting income type must remain unsupported");
      must(wrongIncomeType.withholding_calculations[0].reason_codes.includes("income_profile_conflict"),
        "The personal-service income conflict must use the existing conflict reason");

      const missingFactPayment = lecturePayment("business_lecture", 1000, "missing-fact", calculationDate);
      delete missingFactPayment.lecture_to_many;
      const missingFact = await call("tax_plan_work", {
        matter: calculationMatter([missingFactPayment], calculationDate, "live-missing-lecture-fact"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(missingFact, ["missing-fact"], "A missing scope fact must block calculation");
      same(missingFact.withholding_calculations[0].status, "needs_facts", "Missing scope facts must be requested");
      same(missingFact.withholding_calculations[0].reason_codes[0], "missing_required_facts",
        "Missing scope facts must use the targeted reason");
      must(missingFact.withholding_calculations[0].missing_facts.includes("lecture_to_many"),
        "The missing fact list must identify lecture_to_many");

      const missingPayeePayment = lecturePayment("business_lecture", 1000, "missing-payee-entity", calculationDate);
      delete missingPayeePayment.payee_entity;
      const missingPayeeEntity = await call("tax_plan_work", {
        matter: calculationMatter([missingPayeePayment], calculationDate, "live-missing-payee-entity"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(missingPayeeEntity, ["missing-payee-entity"],
        "A missing individual payee classification must not compute");
      same(missingPayeeEntity.withholding_calculations[0].status, "needs_facts",
        "A missing individual payee classification must request facts");
      must(missingPayeeEntity.withholding_calculations[0].missing_facts.includes("payee_entity"),
        "The missing fact list must identify payee_entity");

      const historicalPayment = lecturePayment("business_lecture", 1000, "historical-date", "2026-10-19");
      const historical = await call("tax_plan_work", {
        matter: calculationMatter([historicalPayment], calculationDate, "live-historical-payment"),
        include_evidence: true,
      });
      assertNoCalculatedAmounts(historical, ["historical-date"], "A payment before the supported law window must not compute");
      same(historical.withholding_calculations[0].status, "blocked", "An out-of-scope payment date must block calculation");
      must(historical.withholding_calculations[0].reason_codes.includes("date_out_of_scope"),
        "An out-of-scope payment must identify the date boundary");
      must(historical.withholding_calculations[0].basis_checks.every((check) =>
        check.status === "date_out_of_scope" && check.reason === "date_out_of_scope" &&
        check.actual_text_sha256 === null && check.retrieved_at === null),
      "Out-of-scope basis checks must not claim fetched current law as applicable");

      const conflictingPayment = lecturePayment("business_lecture", 1000, "profile-conflict", calculationDate);
      conflictingPayment.income_type = "wage";
      const conflict = await call("tax_plan_work", {
        matter: calculationMatter([conflictingPayment], calculationDate, "live-profile-conflict"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(conflict, ["profile-conflict"], "A profile incompatible with the income type must not compute");
      same(conflict.withholding_calculations[0].status, "unsupported", "A profile conflict must be unsupported");
      must(conflict.withholding_calculations[0].reason_codes.includes("income_profile_conflict"),
        "A profile conflict must identify the income type mismatch");

      const lectureAnswerWithoutEvidence = await call("tax_answer_practitioner_question", {
        matter: businessMatter, include_evidence: false,
      });
      same(lectureAnswerWithoutEvidence.final_decision, "not_issued", "Evidence-disabled practitioner output must remain a draft");
      const otherLectureAnswerWithoutEvidence = await call("tax_answer_practitioner_question", {
        matter: otherMatter, include_evidence: false,
      });
      same(otherLectureAnswerWithoutEvidence.final_decision, "not_issued",
        "Evidence-disabled other lecture output must remain a draft");
      const personalServiceAnswerWithoutEvidence = await call("tax_answer_practitioner_question", {
        matter: personalServiceMatter, include_evidence: false,
      });
      const otherPersonalServiceAnswerWithoutEvidence = await call("tax_answer_practitioner_question", {
        matter: otherPersonalMatter, include_evidence: false,
      });
      same(personalServiceAnswerWithoutEvidence.final_decision, "not_issued",
        "Evidence-disabled personal-service output must remain a draft");
      assertNoComputedTaxAssessments(lectureAnswerWithoutEvidence,
        "Evidence-disabled business lecture answer");
      assertNoComputedTaxAssessments(otherLectureAnswerWithoutEvidence,
        "Evidence-disabled other lecture answer");
      assertNoComputedTaxAssessments(personalServiceAnswerWithoutEvidence,
        "Evidence-disabled personal-service answer");
      assertNoComputedTaxAssessments(otherPersonalServiceAnswerWithoutEvidence,
        "Evidence-disabled other-personal-service answer");
      for (const [answerWithoutEvidence, payments, profile] of [
        [lectureAnswerWithoutEvidence, businessMatter.facts.payments, "business_lecture"],
        [otherLectureAnswerWithoutEvidence, otherMatter.facts.payments, "other_lecture"],
        [personalServiceAnswerWithoutEvidence, personalServiceMatter.facts.payments, "business_personal_service"],
        [otherPersonalServiceAnswerWithoutEvidence, otherPersonalMatter.facts.payments, "other_personal_service"],
      ]) {
        for (const item of payments) {
          const row = decodedCalculationSection(answerWithoutEvidence, item.payment_id, profile);
          const lines = row.text.split(/\r?\n/u);
          must(lines.some((line) => line.startsWith("행 상태: blocked;")),
            `${item.payment_id} practitioner row must remain blocked without evidence`);
          if (profile === "business_personal_service") {
            const serviceSubtype = PERSONAL_SERVICE_SUBTYPES[item.service_subtype];
            must(serviceSubtype && lines.includes(
              `용역 세부유형: ${item.service_subtype} (${serviceSubtype.label})`),
            `${item.payment_id} practitioner row must retain its selected subtype without evidence`);
          } else if (profile === "other_personal_service") {
            const subtype = OTHER_PERSONAL_SERVICE_SUBTYPES[item.other_service_subtype];
            must(subtype && row.text.includes(`${item.other_service_subtype} (${subtype.label})`),
              `${item.payment_id} practitioner row must retain its selected other-service subtype without evidence`);
          }
          for (const forbidden of ["국세율:", "국세 원천징수 후보:", "지방소득세율:",
            "총 원천징수 후보:", "순지급액:"]) {
            must(!lines.some((line) => line.startsWith(forbidden)),
              `${item.payment_id} practitioner row must not project ${forbidden} without evidence`);
          }
        }
      }

      const lectureAnswer = await call("tax_answer_practitioner_question", {
        matter: businessMatter, include_evidence: true,
      });
      same(lectureAnswer.final_decision, "not_issued", "Practitioner calculation must not issue a final decision");
      same(lectureAnswer.applicability, "not_determined", "Practitioner calculation must retain whole-matter applicability");
      must(Array.isArray(lectureAnswer.assessments) && lectureAnswer.assessments.length > 0 &&
        lectureAnswer.assessments.every((item) => item.reliance === "do_not_rely_verify_source"),
      "Practitioner calculation assessments must retain their review warning");
      const lectureSections = lectureAnswer.perspective_view?.sections ?? {};
      must(Array.isArray(lectureSections.withholding_basis_checks) && lectureSections.withholding_basis_checks.length > 0,
        "Practitioner output must project the matched calculation basis checks");
      assertPractitionerBasisProjection(lectureAnswer, businessPlan.result);

      const otherLectureAnswer = await call("tax_answer_practitioner_question", {
        matter: otherMatter, include_evidence: true,
      });
      same(otherLectureAnswer.final_decision, "not_issued", "Other lecture practitioner result must not issue a final decision");
      same(otherLectureAnswer.applicability, "not_determined",
        "Other lecture practitioner result must preserve whole-matter applicability");
      must(Array.isArray(otherLectureAnswer.assessments) &&
        otherLectureAnswer.assessments.every((item) => item.reliance === "do_not_rely_verify_source"),
      "Other lecture practitioner assessments must retain their review warning");
      must(Array.isArray(otherLectureAnswer.perspective_view?.sections?.withholding_basis_checks) &&
        otherLectureAnswer.perspective_view.sections.withholding_basis_checks.length > 0,
      "Other lecture practitioner output must project its matched basis checks");
      assertPractitionerBasisProjection(otherLectureAnswer, otherPlan.result);

      const personalServiceAnswer = await call("tax_answer_practitioner_question", {
        matter: personalServiceMatter, include_evidence: true,
      });
      same(personalServiceAnswer.final_decision, "not_issued",
        "Personal-service practitioner output must not issue a final decision");
      same(personalServiceAnswer.applicability, "not_determined",
        "Personal-service practitioner output must preserve whole-matter applicability");
      must(Array.isArray(personalServiceAnswer.assessments) &&
        personalServiceAnswer.assessments.every((item) => item.reliance === "do_not_rely_verify_source"),
      "Personal-service practitioner assessments must retain their review warning");
      assertPractitionerBasisProjection(personalServiceAnswer, personalServicePlan.result);

      const otherPersonalServiceAnswer = await call("tax_answer_practitioner_question", {
        matter: otherPersonalMatter, include_evidence: true,
      });
      same(otherPersonalServiceAnswer.final_decision, "not_issued",
        "Other-personal-service practitioner output must not issue a final decision");
      same(otherPersonalServiceAnswer.applicability, "not_determined",
        "Other-personal-service practitioner output must preserve whole-matter applicability");
      must(Array.isArray(otherPersonalServiceAnswer.assessments) &&
        otherPersonalServiceAnswer.assessments.every((item) => item.reliance === "do_not_rely_verify_source"),
      "Other-personal-service practitioner assessments must retain their review warning");
      assertPractitionerBasisProjection(otherPersonalServiceAnswer, otherPersonalPlan.result);

      const separateOtherServicePractitionerAnswers = {};
      for (const sample of [
        { subtype: "manuscript_fee", gross: 125000, paymentId: "other-service-manuscript-125000",
          actualWithheld: "미제공", comparisonOutcome: "comparison_false_candidate",
          comparisonStatus: "actual_withheld_not_provided", national: "0", local: "0", total: "0", net: "125000",
          nationalExpression: /소득금액\s*50000원\s*≤\s*50,000원\s*과세최저한\s*→\s*0원/u,
          localExpression: /10원 단위 절사\(0\s*×\s*0\.1\)/u,
          values: { gross_amount: "125000", expense_rate: "0.6", expense_amount: "75000", income_amount: "50000",
            tax_base: "50000", national_tax: "0", local_tax: "0", total_withholding: "0", net_payment: "125000" } },
        { subtype: "expert_advisory", gross: 125001, paymentId: "other-service-advisory-125001",
          actualWithheld: "10000원", comparisonOutcome: "comparison_true_candidate",
          comparisonStatus: "matches_national_tax", national: "10000", local: "1000", total: "11000", net: "114001",
          nationalExpression: /10원 단위 절사\(50000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(10000\s*×\s*0\.1\)/u,
          values: { gross_amount: "125001", expense_rate: "0.6", expense_amount: "75000.6", income_amount: "50000.4",
            tax_base: "50000", national_tax: "10000", local_tax: "1000", total_withholding: "11000", net_payment: "114001" } },
        { subtype: "broadcast_commentary", gross: 1000000, paymentId: "other-service-broadcast-1000000",
          actualWithheld: "88000원", comparisonOutcome: "comparison_true_candidate",
          comparisonStatus: "differs_from_national_tax", national: "80000", local: "8000", total: "88000", net: "912000",
          nationalExpression: /10원 단위 절사\(400000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(80000\s*×\s*0\.1\)/u,
          values: { gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
            tax_base: "400000", national_tax: "80000", local_tax: "8000", total_withholding: "88000", net_payment: "912000" } },
      ]) {
        const payment = otherPersonalServicePayment(sample.subtype, sample.gross, sample.paymentId, calculationDate);
        if (sample.subtype === "expert_advisory") payment.withheld_amount = "10000";
        if (sample.subtype === "broadcast_commentary") payment.withheld_amount = "88000";
        const answer = await call("tax_answer_practitioner_question", {
          matter: calculationMatter([payment], calculationDate, `live-practitioner-${sample.paymentId}`),
          include_evidence: true,
        });
        same(answer.final_decision, "not_issued", `${sample.paymentId} practitioner answer must remain a draft`);
        same(answer.applicability, "not_determined", `${sample.paymentId} answer must preserve matter-level applicability`);
        must(Array.isArray(answer.assessments) && answer.assessments.length > 0 &&
          answer.assessments.every((item) => item.reliance === "do_not_rely_verify_source"),
        `${sample.paymentId} practitioner answer must retain its review warning`);
        const subtype = OTHER_PERSONAL_SERVICE_SUBTYPES[sample.subtype];
        const row = otherPersonalRows.get(sample.paymentId);
        must(subtype && row, `${sample.paymentId} must have the expected matched plan row`);
        const expected = {
          paymentId: sample.paymentId,
          profile: "other_personal_service",
          otherServiceSubtype: sample.subtype,
          otherServiceSubtypeLabel: subtype.label,
          applicability: sample.gross === 125000 ? "below_taxable_minimum" : "applies",
          national: sample.national,
          local: sample.local,
          formula: row.formula,
          nationalExpression: sample.nationalExpression,
          localExpression: sample.localExpression,
          nationalRate: "0.2",
          localRate: "0.1",
          total: sample.total,
          net: sample.net,
          actualWithheld: sample.actualWithheld,
          comparisonOutcome: sample.comparisonOutcome,
          comparisonStatus: sample.comparisonStatus,
          values: sample.values,
        };
        assertTypedPaymentAssessments(answer, expected);
        assertPractitionerCalculationSection(answer, expected);
        assertPractitionerBasisProjection(answer, otherPersonalPlan.result, [sample.paymentId]);
        separateOtherServicePractitionerAnswers[sample.subtype] = answer;
      }

      for (const expected of [
        { paymentId: "business-33333", profile: "business_lecture", applicability: "applies",
          national: "990", local: "90", formula: business33333.formula,
          nationalExpression: /10원 단위 절사\(33333\s*×\s*0\.03\)/u, localExpression: /10원 단위 절사\(990\s*×\s*0\.1\)/u,
          nationalRate: "0.03", localRate: "0.1", total: "1080", net: "32253", actualWithheld: "1000원",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "differs_from_national_tax",
          values: { gross_amount: "33333", expense_amount: null, income_amount: "33333", tax_base: "33333",
            national_tax: "990", local_tax: "90", total_withholding: "1080", net_payment: "32253" } },
        { paymentId: "business-10000", profile: "business_lecture", applicability: "applies",
          national: "300", local: "30", formula: business10000.formula,
          nationalExpression: /10원 단위 절사\(10000\s*×\s*0\.03\)/u, localExpression: /10원 단위 절사\(300\s*×\s*0\.1\)/u,
          nationalRate: "0.03", localRate: "0.1", total: "330", net: "9670", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "10000", expense_amount: null, income_amount: "10000", tax_base: "10000",
            national_tax: "300", local_tax: "30", total_withholding: "330", net_payment: "9670" } },
      ]) {
        assertTypedPaymentAssessments(lectureAnswer, expected);
        assertPractitionerCalculationSection(lectureAnswer, expected);
      }
      for (const expected of [
        { paymentId: "other-125000", profile: "other_lecture", applicability: "below_taxable_minimum",
          national: "0", local: "0", formula: other125000.formula,
          nationalExpression: /소득금액\s*50000원\s*≤\s*50,000원\s*과세최저한\s*→\s*0원/u,
          localExpression: /10원 단위 절사\(0\s*×\s*0\.1\)/u,
          nationalRate: "0.2", localRate: "0.1", total: "0", net: "125000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_false_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "125000", expense_rate: "0.6", expense_amount: "75000", income_amount: "50000",
            tax_base: "50000", national_tax: "0", local_tax: "0", total_withholding: "0", net_payment: "125000" } },
        { paymentId: "other-125001", profile: "other_lecture", applicability: "applies",
          national: "10000", local: "1000", formula: other125001.formula,
          nationalExpression: /10원 단위 절사\(50000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(10000\s*×\s*0\.1\)/u,
          nationalRate: "0.2", localRate: "0.1", total: "11000", net: "114001", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "125001", expense_rate: "0.6", expense_amount: "75000.6", income_amount: "50000.4",
            tax_base: "50000", national_tax: "10000", local_tax: "1000", total_withholding: "11000", net_payment: "114001" } },
        { paymentId: "other-1000000", profile: "other_lecture", applicability: "applies",
          national: "80000", local: "8000", formula: other1000000.formula,
          nationalExpression: /10원 단위 절사\(400000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(80000\s*×\s*0\.1\)/u,
          nationalRate: "0.2", localRate: "0.1", total: "88000", net: "912000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
            tax_base: "400000", national_tax: "80000", local_tax: "8000", total_withholding: "88000", net_payment: "912000" } },
      ]) {
        assertTypedPaymentAssessments(otherLectureAnswer, expected);
        assertPractitionerCalculationSection(otherLectureAnswer, expected);
      }

      for (const expected of [
        { paymentId: "personal-translation-33333", profile: "business_personal_service",
          serviceSubtype: "translation", serviceSubtypeLabel: PERSONAL_SERVICE_SUBTYPES.translation.label,
          applicability: "applies", national: "990", local: "90", formula: personalTranslation33333.formula,
          nationalExpression: /10원 단위 절사\(33333\s*×\s*0\.03\)/u,
          localExpression: /10원 단위 절사\(990\s*×\s*0\.1\)/u,
          nationalRate: "0.03", localRate: "0.1", total: "1080", net: "32253", actualWithheld: "990원",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "matches_national_tax",
          values: { gross_amount: "33333", expense_amount: null, income_amount: "33333", tax_base: "33333",
            national_tax: "990", local_tax: "90", total_withholding: "1080", net_payment: "32253" } },
        { paymentId: "personal-authorship", profile: "business_personal_service",
          serviceSubtype: "authorship", serviceSubtypeLabel: PERSONAL_SERVICE_SUBTYPES.authorship.label,
          applicability: "applies", national: "30000", local: "3000",
          formula: personalSubtypeRows.get("authorship").formula,
          nationalExpression: /10원 단위 절사\(1000000\s*×\s*0\.03\)/u,
          localExpression: /10원 단위 절사\(30000\s*×\s*0\.1\)/u,
          nationalRate: "0.03", localRate: "0.1", total: "33000", net: "967000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "1000000", expense_amount: null, income_amount: "1000000", tax_base: "1000000",
            national_tax: "30000", local_tax: "3000", total_withholding: "33000", net_payment: "967000" } },
        { paymentId: "personal-entertainment_direction", profile: "business_personal_service",
          serviceSubtype: "entertainment_direction",
          serviceSubtypeLabel: PERSONAL_SERVICE_SUBTYPES.entertainment_direction.label,
          applicability: "applies", national: "30000", local: "3000",
          formula: personalSubtypeRows.get("entertainment_direction").formula,
          nationalExpression: /10원 단위 절사\(1000000\s*×\s*0\.03\)/u,
          localExpression: /10원 단위 절사\(30000\s*×\s*0\.1\)/u,
          nationalRate: "0.03", localRate: "0.1", total: "33000", net: "967000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "1000000", expense_amount: null, income_amount: "1000000", tax_base: "1000000",
            national_tax: "30000", local_tax: "3000", total_withholding: "33000", net_payment: "967000" } },
      ]) {
        assertTypedPaymentAssessments(personalServiceAnswer, expected);
        assertPractitionerCalculationSection(personalServiceAnswer, expected);
      }

      for (const expected of [
        { paymentId: "other-service-manuscript-1000000", subtype: "manuscript_fee", applicability: "applies",
          national: "80000", local: "8000", total: "88000", net: "912000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          nationalExpression: /10원 단위 절사\(400000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(80000\s*×\s*0\.1\)/u,
          values: { gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
            tax_base: "400000", national_tax: "80000", local_tax: "8000", total_withholding: "88000", net_payment: "912000" } },
        { paymentId: "other-service-advisory-1000000", subtype: "expert_advisory", applicability: "applies",
          national: "80000", local: "8000", total: "88000", net: "912000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          nationalExpression: /10원 단위 절사\(400000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(80000\s*×\s*0\.1\)/u,
          values: { gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
            tax_base: "400000", national_tax: "80000", local_tax: "8000", total_withholding: "88000", net_payment: "912000" } },
        { paymentId: "other-service-broadcast-1000000", subtype: "broadcast_commentary", applicability: "applies",
          national: "80000", local: "8000", total: "88000", net: "912000", actualWithheld: "88000원",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "differs_from_national_tax",
          nationalExpression: /10원 단위 절사\(400000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(80000\s*×\s*0\.1\)/u,
          values: { gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
            tax_base: "400000", national_tax: "80000", local_tax: "8000", total_withholding: "88000", net_payment: "912000" } },
        { paymentId: "other-service-manuscript-125000", subtype: "manuscript_fee", applicability: "below_taxable_minimum",
          national: "0", local: "0", total: "0", net: "125000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_false_candidate", comparisonStatus: "actual_withheld_not_provided",
          nationalExpression: /소득금액\s*50000원\s*≤\s*50,000원\s*과세최저한\s*→\s*0원/u,
          localExpression: /10원 단위 절사\(0\s*×\s*0\.1\)/u,
          values: { gross_amount: "125000", expense_rate: "0.6", expense_amount: "75000", income_amount: "50000",
            tax_base: "50000", national_tax: "0", local_tax: "0", total_withholding: "0", net_payment: "125000" } },
        { paymentId: "other-service-advisory-125001", subtype: "expert_advisory", applicability: "applies",
          national: "10000", local: "1000", total: "11000", net: "114001", actualWithheld: "10000원",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "matches_national_tax",
          nationalExpression: /10원 단위 절사\(50000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(10000\s*×\s*0\.1\)/u,
          values: { gross_amount: "125001", expense_rate: "0.6", expense_amount: "75000.6", income_amount: "50000.4",
            tax_base: "50000", national_tax: "10000", local_tax: "1000", total_withholding: "11000", net_payment: "114001" } },
        { paymentId: "other-service-broadcast-1000123", subtype: "broadcast_commentary", applicability: "applies",
          national: "80000", local: "8000", total: "88000", net: "912123", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          nationalExpression: /10원 단위 절사\(400049\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(80000\s*×\s*0\.1\)/u,
          values: { gross_amount: "1000123", expense_rate: "0.6", expense_amount: "600073.8", income_amount: "400049.2",
            tax_base: "400049", national_tax: "80000", local_tax: "8000", total_withholding: "88000", net_payment: "912123" } },
      ]) {
        const subtype = OTHER_PERSONAL_SERVICE_SUBTYPES[expected.subtype];
        const row = otherPersonalRows.get(expected.paymentId);
        must(subtype && row, `${expected.paymentId} must have known subtype metadata and a live calculation row`);
        const practitionerExpected = {
          paymentId: expected.paymentId,
          profile: "other_personal_service",
          otherServiceSubtype: expected.subtype,
          otherServiceSubtypeLabel: subtype.label,
          applicability: expected.applicability,
          national: expected.national,
          local: expected.local,
          formula: row.formula,
          nationalExpression: expected.nationalExpression,
          localExpression: expected.localExpression,
          nationalRate: "0.2",
          localRate: "0.1",
          total: expected.total,
          net: expected.net,
          actualWithheld: expected.actualWithheld,
          comparisonOutcome: expected.comparisonOutcome,
          comparisonStatus: expected.comparisonStatus,
          values: expected.values,
        };
        assertTypedPaymentAssessments(otherPersonalServiceAnswer, practitionerExpected);
        assertPractitionerCalculationSection(otherPersonalServiceAnswer, practitionerExpected);
      }

      savePrivateLiveReceipt({ business_plan: businessPlan.result, other_plan: otherPlan.result,
        other_personal_service_plan: otherPersonalPlan.result,
        personal_service_plan: personalServicePlan.result, personal_service_boundary_plan: personalBoundaryPlan.result,
        actual_expense_plan: actualExpensePlan.result,
        loss_calculations: lossPlan.result,
        loss_answers: lossPractitionerAnswers,
        payment_isolation: paymentIsolationPlan.result,
        payment_isolation_answer: paymentIsolationAnswer,
        practitioner_business_answer: lectureAnswer, practitioner_other_answer: otherLectureAnswer,
        practitioner_personal_service_answer: personalServiceAnswer,
        practitioner_other_personal_service_answer: otherPersonalServiceAnswer,
        practitioner_other_personal_service_manuscript_answer: separateOtherServicePractitionerAnswers.manuscript_fee,
        practitioner_other_personal_service_advisory_answer: separateOtherServicePractitionerAnswers.expert_advisory,
        practitioner_other_personal_service_broadcast_answer: separateOtherServicePractitionerAnswers.broadcast_commentary,
        practitioner_other_actual_lecture_answer: actualExpensePractitionerAnswers.lecture,
        practitioner_other_actual_service_answer: actualExpensePractitionerAnswers.service,
        practitioner_other_actual_threshold_answer: actualExpensePractitionerAnswers.threshold,
        practitioner_other_loss_lecture_answer: lossPractitionerAnswers.lecture,
        practitioner_other_loss_manuscript_answer: lossPractitionerAnswers.manuscript });

      const allLive = JSON.stringify([search, article, withEvidence, answer, businessPlan.result, otherPlan.result,
        otherPersonalPlan.result, actualExpensePlan.result, personalServicePlan.result, personalBoundaryPlan.result,
        lossPlan.result, paymentIsolationPlan.result, paymentIsolationAnswer,
        ...Object.values(actualExpensePractitionerAnswers), ...Object.values(lossPractitionerAnswers),
        ...actualNegativeResults, noEvidenceActual, noEvidenceLoss, lectureAnswerWithoutEvidence,
        lectureAnswer, otherPersonalServiceAnswerWithoutEvidence, otherPersonalServiceAnswer,
        personalServiceAnswerWithoutEvidence, personalServiceAnswer, noEvidence, unknownProfile, missingFact,
        missingPayeeEntity, otherLectureAnswerWithoutEvidence, otherLectureAnswer, noEvidenceOther,
        noEvidenceOtherPersonal, noEvidencePersonal, historical, conflict, missingSubtype, unsupportedSubtype,
        missingOtherSubtype, ...missingOtherScopeResults, unsupportedOtherSubtype, falseOtherScope,
        otherProfileBusinessSubtypeResult, businessProfileOtherSubtypeResult, businessIncomeOtherServiceResult,
        continuingOtherServiceResult, wrongIncomeType, ...Object.values(separateOtherServicePractitionerAnswers)]);
      must(!allLive.includes("OC="), "Serialized live outputs must not contain authenticated OC parameters");
      process.stdout.write(JSON.stringify({
        live: "passed", tax_tools: 19, article: "fetched", evidence: "completed",
        legal_documents: withEvidence.evidence_lookup.legal_documents_count,
        candidates: withEvidence.evidence_lookup.candidate_count,
        resolved_forms: withEvidence.evidence_lookup.resolved_forms_count,
        practitioner: "evidence_attached",
        business_calculations: businessPlan.result.withholding_calculations.length,
        other_calculations: otherPlan.result.withholding_calculations.length,
        other_personal_service_calculations: otherPersonalPlan.result.withholding_calculations.length,
        actual_expense_calculations: actualExpensePlan.result.withholding_calculations.length,
        actual_expense_practitioner_answers: Object.keys(actualExpensePractitionerAnswers).length,
        loss_calculations: lossPlan.result.withholding_calculations.length,
        loss_practitioner_answers: Object.keys(lossPractitionerAnswers).length,
        payment_isolation_calculations: paymentIsolationPlan.result.withholding_calculations.length,
        personal_service_calculations: personalServicePlan.result.withholding_calculations.length,
        budget_retry_calls: retryBudget.used,
      }) + "\n");
    });

    const missingCredentialPath = join(scratch, "intentionally-missing-credentials.json");
    must(!existsSync(missingCredentialPath), "Negative credential fixture must begin absent");
    await withUpper(scratch, missingCredentialPath, async (_client, call) => {
      const missingCredentialMatter = calculationMatter([
        lecturePayment("business_lecture", 33333, "missing-credential-lecture", calculationDate),
        personalServicePayment("translation", 33333, "missing-credential-personal-service", calculationDate),
        otherPersonalServicePayment("expert_advisory", 33333, "missing-credential-other-personal-service", calculationDate),
        actualExpensePayment("other_lecture", undefined, 1000000, 700000,
          "missing-credential-actual-expense", calculationDate),
      ], calculationDate, "live-missing-credential-calculations");
      const without = await call("tax_plan_work", { matter: missingCredentialMatter, include_evidence: false });
      const result = await call("tax_plan_work", { matter: missingCredentialMatter, include_evidence: true });
      same(result.status, without.status, "Missing credentials must not change plan status");
      equivalent(result.questions, without.questions, "Missing credentials must not change the supplied-fact questions");
      same(result.applicability, "not_determined", "Missing credentials must not decide whole-matter applicability");
      const missingCredentialPaymentIds = ["missing-credential-lecture", "missing-credential-personal-service",
        "missing-credential-other-personal-service", "missing-credential-actual-expense"];
      assertNoCalculatedAmounts(without, missingCredentialPaymentIds,
        "An evidence-disabled lecture calculation must not contain amounts");
      assertNoCalculatedAmounts(result, missingCredentialPaymentIds,
        "Missing credentials must leave all selected calculation amounts empty");
      same(result.calculation_status, "blocked", "Missing current-law credentials must block calculation");
      const calcRows = result.withholding_calculations;
      same(calcRows.length, 4, "Missing credential acceptance must include lecture, both service profiles, and actual-expense rows");
      const personalServiceRow = calcRows.find((row) => row.payment_id === "missing-credential-personal-service");
      same(personalServiceRow.profile, "business_personal_service",
        "Missing credential acceptance must include the selected new profile");
      same(personalServiceRow.service_subtype, "translation",
        "Missing credential acceptance must preserve the new service subtype");
      const otherPersonalServiceRow = calcRows.find((row) => row.payment_id === "missing-credential-other-personal-service");
      same(otherPersonalServiceRow.profile, "other_personal_service",
        "Missing credential acceptance must include the bounded temporary-service profile");
      same(otherPersonalServiceRow.other_service_subtype, "expert_advisory",
        "Missing credential acceptance must preserve the temporary-service subtype");
      const actualExpenseRow = calcRows.find((row) => row.payment_id === "missing-credential-actual-expense");
      same(actualExpenseRow.profile, "other_lecture", "Missing credential acceptance must retain the actual-expense profile");
      same(actualExpenseRow.expense_method, "actual", "Missing credential acceptance must retain actual method selection");
      must(actualExpenseRow.rule_ids.includes("WH-CALC-OTHER-ACTUAL-SCOPE") &&
        actualExpenseRow.rule_ids.includes("WH-CALC-OTHER-ACTUAL-WITHHOLDING"),
      "Missing credentials must not bypass the selected actual-expense basis cards");
      for (const calcRow of calcRows) {
        same(calcRow.status, "blocked", "Missing current-law credentials must block every payment row");
        must(calcRow.reason_codes.includes("credential_missing"),
          "Calculation must report credential_missing safely");
        must(calcRow.basis_checks.length > 0 && calcRow.basis_checks.some((check) =>
          check.status === "unavailable" && check.reason === "credential_missing"),
        "Missing-credential basis checks must report the safe credential_missing reason");
      }
      same(result.evidence_lookup?.status, "unavailable", "Missing credentials must produce unavailable evidence state");
      must(result.evidence_lookup.error_codes.includes("credential_missing"),
        "Missing credential state must identify credential_missing");
      same(result.evidence_lookup.legal_documents_count, 0, "Missing credentials cannot attach a law document");
      same(result.evidence_lookup.candidate_count, 0, "Missing credentials cannot attach a candidate");
      same((result.evidence_candidates ?? []).length, 0, "Missing credentials must leave candidate rows empty");
      must((result.legal_evidence ?? []).every((row) => row.status !== "fetched"),
        "Missing credentials must not produce fetched legal evidence");
      must((result.unresolved ?? []).some((row) => row.code === "EVIDENCE_LOOKUP_UNAVAILABLE"),
        "Missing credentials must provide a non-blocking evidence warning");
      must(!JSON.stringify(result).includes(missingCredentialPath), "Missing credentials must not expose the local credential path");
      must(!JSON.stringify(result).includes("OC="), "Missing-credential output must not expose authenticated transport parameters");
      process.stdout.write(JSON.stringify({ negative_fixture: "passed", evidence: "unavailable", code: "credential_missing" }) + "\n");
    });
  } catch (error) {
    // Assertion text is authored locally and safe. Suppress runtime/transport text and paths.
    if (error instanceof AcceptanceFailure) throw error;
    throw new AcceptanceFailure("Required live tax evidence acceptance failed; private diagnostics suppressed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
