# AgentLink Korea MCP Server

**AI agents' gateway to Korean public & financial data**
**AI 에이전트를 위한 한국 공공·재무 데이터 게이트웨이**

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that provides AI agents with structured access to Korean government and financial data sources — including HomeTax (홈택스), KONEPS (나라장터), Supreme Court (대법원), and more.

## Available Tools

### Demo data tools (데모 데이터, 명시적 opt-in 필요)
| Tool | Description |
|------|-------------|
| `get_vat_data` | Retrieve VAT data for a business (부가가치세 데이터 조회) |
| `get_tax_invoice` | Look up electronic tax invoices (전자세금계산서 조회) |
| `get_income_tax_summary` | Retrieve income tax summary (소득세 요약 조회) |

### Business Registration (사업자 정보)
| Tool | Description |
|------|-------------|
| `verify_business_registration` | Verify a business registration number (사업자등록번호 진위 확인) |
| `get_business_info` | Retrieve detailed business info (사업자 상세 정보 조회) |

### Public Data (공공 데이터)
| Tool | Description |
|------|-------------|
| `search_public_notices` | Search government notices (공공 고시/공고 검색) |
| `get_procurement_data` | Retrieve procurement/bidding data from KONEPS (조달청 입찰/계약 데이터 조회) |

### Legal Data (법률 데이터)
| Tool | Description |
|------|-------------|
| `search_court_precedents` | Search court precedents (대법원 판례 검색) |

### Disaster & Safety (재난 안전)
| Tool | Description |
|------|-------------|
| `get_disaster_alerts` | Retrieve disaster alerts from MOIS (행정안전부 재난 알림 조회) |

세무 도메인 도구는 설치된 도메인 MCP가 발견 및 계약 검증을 통과한 뒤에만 표시됩니다. 보조금·R&D 실무자 도구 7개는 별도로 설정한 경우에만 표시되며 같은 방식으로 검증됩니다. 도메인 도구의 결과는 검토용 초안이며 적용 여부는 판단되지 않습니다. 보조금 도메인 도구는 공식 원문 로컬 사본을 사용하며 개정 여부는 결과의 `public_url`에서 확인하세요. 설정과 한계는 [세무 전용 설정 안내](docs/TAX_ONLY_SETUP.md)와 [보조금 도메인 브리지 문서](docs/SUBSIDY_DOMAIN_BRIDGE.md)를 참고하세요. 데모 스텁 도구는 기본적으로 숨겨지며 `AGENTLINK_DEMO_TOOLS=1`로 명시적으로 켤 수 있습니다.

## Quick Start

### Installation

```bash
npm install
npm run build
```

### Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentlink-korea": {
      "command": "node",
      "args": ["/path/to/agentlink-mcp-server/dist/index.js"]
    }
  }
}
```

### Usage with Claude Code

```bash
claude mcp add agentlink-korea node /path/to/agentlink-mcp-server/dist/index.js
```

### Direct Execution

```bash
npx agentlink-mcp-server
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev
```

## 세무 도메인 연결

설치된 세무 도메인 MCP 서버를 로컬 stdio 브리지로 연결합니다. 시작 시 자식 서버의 `tools/list`를 페이지 제한과 시간 제한 안에서 읽고, 공개 도구 계약과 맞는 경우에만 해당 도메인의 도구를 표시합니다. 초기 검증이 끝난 뒤 상위 stdio 연결을 시작합니다. `agentlink_bridge_status`는 준비 상태와 검증된 도구 이름을 보여주며 `refresh: true`로 재검증을 시도할 수 있습니다.

| 환경 변수 | 설명 | 기본값 |
|---|---|---|
| `AGENTLINK_TAX_MCP_COMMAND` | 실행 명령 | `python3` |
| `AGENTLINK_TAX_MCP_ARGS` | 인자 (JSON 배열) | `["-m","agentlink_tax.server"]` |
| `AGENTLINK_TAX_MCP_PYTHONPATH` | 자식 프로세스 `PYTHONPATH` (선택) | - |
| `AGENTLINK_TAX_REGISTRY` | 지원 설치에서는 사용하지 않음; 필수 설치 검증에서 override 금지 | - |

자식 프로세스에는 `PATH, HOME, LANG, LC_ALL, TZ, TMPDIR, PYTHONPATH, AGENTLINK_CREDENTIALS_PATH, AGENTLINK_TAX_REGISTRY, AGENTLINK_AUTOMATION_OFFER_PATH, HTTPS_PROXY, HTTP_PROXY, NO_PROXY`(소문자 변형 포함), `SSL_CERT_FILE, REQUESTS_CA_BUNDLE`만 전달됩니다.

세무 도메인 wheel에는 해당 릴리스의 canonical 레지스트리가 포함됩니다. 지원되는 설치 조합에서는 `AGENTLINK_TAX_REGISTRY`와 source-tree `PYTHONPATH`를 설정하지 않습니다. 휠 설치, MCP 클라이언트 설정, 상태 확인과 실통합 시험은 [세무 전용 설정 안내](docs/TAX_ONLY_SETUP.md)를 참고하세요. 기본 시작은 세무 도메인 도구를 검증하지만 세무 도메인이 없거나 계약이 다르면 상태 도구만 표시합니다.

상위 패키지 설치 때 `PATH`에 추가된 `agentlink-tax-doctor` 실행 파일로 연결, 브리지, 필수 도구, 도메인 상태와 workflow catalog를 확인할 수 있습니다. 이 검사는 자격증명 존재 여부만 확인하며 제공처 호출은 하지 않습니다. `live_provider_status`는 `not_checked`, 신고 상태는 `not_supported`로 반환됩니다.

`tax_create_draft_bundle`은 부가세 매입 내역, 법인세 장부·신고 금액 대사, 원천세 작성 안내를 검토용 JSON·CSV로 제공합니다. 누락 값과 0원을 구분하고 입력 행·증빙 참조를 유지합니다. 서버에 파일을 저장하지 않으며 세액 확정이나 신고 제출을 수행하지 않습니다. 자세한 입력·설치 검증은 [세무 전용 설정 안내](docs/TAX_ONLY_SETUP.md)를 참고하세요.

도구 (모두 읽기 전용): `tax_route_question`, `tax_health`, `tax_create_draft_bundle`, `tax_list_workflows`, `tax_get_workflow_contract`, `tax_plan_work`, `tax_get_automation_offer`, `tax_list_rule_cards`, `tax_search_law`, `tax_get_law_article`, `tax_check_business_status`, `tax_list_practice_cards`, `tax_list_holidays`, `tax_get_schedule`, `tax_find_office`, `tax_search_interpretations`, `tax_get_tribunal_decision`, `tax_search_forms`, `tax_list_form_guides`, `tax_get_form_field_tips`, `tax_answer_practitioner_question`, `tax_export_rule_cards`. `tax_plan_work`는 선택 인자 `include_evidence`(현행 법령 본문, 해석 후보와 서식 원본 조회)와 `include_filling_guide`(작성 안내 초안 첨부)를 받습니다. `tax_get_law_article`은 법령의 현재 조문 본문과 조회 정보를 반환합니다. `tax_answer_practitioner_question`은 기본적으로 현행 법령 본문·해석 후보·서식 원본을 조회하지 않으며, `include_evidence=true`일 때만 `source_evidence`와 `evidence_lookup` 섹션에 근거 조회 결과를 추가합니다. 현행 본문은 과거 시점 법령이나 사건에 대한 적용 판단이 아니며, 원문 대조 전 상태로 표시됩니다. 성공 결과는 도메인 서버의 `structuredContent`를 그대로 반환하며(오류 결과의 원문은 전달하지 않고 고정된 안전한 메시지의 `TAX_DOMAIN_TOOL_ERROR`로 대체), 검토 대기 초안입니다. 계속·반복하는 독립 강의 지급의 `business_lecture`, 일시적인 강의 지급의 `other_lecture`, 열 가지로 한정한 계속적 독립 인적용역 지급의 `business_personal_service`, 그리고 세 가지로 한정한 일시적 기타 인적용역 지급의 `other_personal_service`에 대해 완전한 사용자 사실과 대조된 현행 법령 근거가 있을 때만 지급별 계산을 제공합니다. `other_personal_service`는 사용자가 유형과 아래의 세부 조건을 모두 확인한 경우에만 검토합니다. `manuscript_fee`는 문예·학술·미술·음악·사진 창작품의 원작자에게 지급하는 소득세법 제21조 제1항 제15호 가목의 원고료이며, 법률상 포함되는 삽화와 창작품·고전의 번역은 포함하지만 인세인 나목이나 창작품 판매 등 다목의 대가는 포함하지 않습니다. `expert_advisory`는 제19호 다목의 전문지식 또는 특별한 기능을 가진 사람이 그 지식·기능을 활용해 일시적으로 제공하고 보수를 받는 용역이며, 제15호부터 제17호까지의 용역이나 전문직업·계속 사업 수입은 포함하지 않습니다. `broadcast_commentary`는 제19호 나목의 라디오·텔레비전 방송 등 방송 매체를 통한 일시적인 해설·계몽·연기 심사 용역이며, 일반 위원회 심사·온라인 콘텐츠·공연·자문은 포함하지 않습니다. 세 유형 모두 이자·배당·사업·근로·연금·퇴직·양도소득, 전문직업 또는 계속 사업의 수입, 인세·라이선스·권리 사용·양도 대가 및 그러한 대가와 분리할 수 없는 혼합 지급이 아니라고 사용자가 확인해야 합니다. 한 번 지급됐다는 사실만으로 기타소득으로 자동 분류하지 않습니다. 지원하는 기타소득 유형은 법령상 60% 표준 필요경비를 넘는 실제 필요경비도 반영할 수 있습니다. 계산된 actual 행은 `expense_method=actual`로 표시하고 `expense_amount`에 실제 필요경비 총액을 담으며, 실제 금액이므로 `expense_rate`는 `null`입니다. 총수입 초과분은 `expense_excess_amount`에 따로 표시합니다. 필요경비가 지급액을 넘으면 지급 건별 기타소득 차액은 음수 `income_amount`로 보존하고, 해당 지급의 원천징수 계산용 과세표준과 원천징수액은 0원, 순지급액은 지급액으로 표시합니다. 이 결과는 지급 한 건의 원천징수 계산이며 연간 기타소득 합산, 다른 소득과의 상계, 결손금 이월 또는 환급을 계산하거나 그 자격을 결정하지 않습니다. 사용자가 이번 지급의 해당 과세기간 수입에 대응하는 통상적·공제 가능한 필요경비의 총액(원 단위 정수)을 입력하고, 총액은 60% 표준액을 넘어야 하며 총수입보다 커도 기존 1,000,000,000,000,000원 상한까지 입력할 수 있고, 지급자가 확인할 수 있는 기록을 갖추었다고 확인한 경우에만 계산합니다. 이는 검증되지 않은 사용자 진술이며 기록을 확인하거나 인증하지 않습니다. 배분, 감가상각, 법정 한도, 시기, 중복 공제 또는 환급·제3자 부담 여부는 별도 검토가 필요합니다. 이 확인은 사용자 진술이며 검증된 법률 분류가 아닙니다. 기존 인적용역 하위 유형은 저술 용역(`authorship`), 도안 용역(`artwork_design`), 삽화 용역(`illustration`), 작곡 용역(`composition`), 성우 용역(`voice_acting`), 연예에 관한 연출 용역(`entertainment_direction`), 연예에 관한 촬영 용역(`entertainment_filming`), 교정 용역(`proofreading`), 번역 용역(`translation`), 속기 용역(`shorthand`)입니다. 인적용역 계산은 거주 개인이 국내에서 계속·독립적으로 제공한 선택 유형의 용역이고, 고용관계가 없으며 사업용 물적 시설을 갖추지 않고 근로자를 고용하지 않으며 고용 외의 형태로 해당 용역의 주된 업무에 대해 타인의 노무 등을 제공받지 않고 특별 세금 처리가 없으며 지급이 완결된 경우만 검토합니다. 일반 프리랜서 활동 전체를 이 유형으로 분류하지 않습니다. 계산을 위해 `include_evidence=true`가 필요하며, 그 외 유형·불완전한 사실·근거 미확인 상태에서는 금액을 제시하지 않습니다. 전체 사안의 적용 여부는 `not_determined`이고 최종 신고 판단이나 제출을 대행하지 않습니다. 입력한 실제 `withheld_amount`는 계산 결과와 별도 값으로 유지됩니다. 호출 제한시간은 30초이며, 실패 시 `tax-bridge-error.v1` (`TAX_DOMAIN_UNAVAILABLE` / `TAX_DOMAIN_TIMEOUT` / `TAX_DOMAIN_TOOL_ERROR` / `TAX_DOMAIN_ERROR`)을 반환합니다.

### 오프라인 검사와 필수 라이브 검사

`npm test`와 `npm run test:integration`은 오프라인 회귀 검사입니다. 두 번째 명령은 설치된 wheel을 실제 upper MCP stdio 경로로 실행하지만 외부 법령 조회를 끄고 존재하지 않는 자격증명 경로를 사용합니다. 라이브 승인에 쓸 새 wheel은 세무 도메인 저장소에서 외부 scratch에 빌드하고 새 Python 환경에 비편집 설치합니다.
`setup.py bdist_wheel`을 실행하는 Python 환경에는 `setuptools`와 `wheel`이 설치되어 있어야 합니다.

```sh
TASK_SCRATCH=/path/to/external-scratch
mkdir -p "$TASK_SCRATCH/egg-info" "$TASK_SCRATCH/build" "$TASK_SCRATCH/wheels" "$TASK_SCRATCH/tmp"
# 세무 도메인 저장소에서:
cd /path/to/tax-repo/services/tax-mcp
python3.12 setup.py egg_info --egg-base "$TASK_SCRATCH/egg-info" \
  build --build-base "$TASK_SCRATCH/build/tax" \
  bdist_wheel --bdist-dir "$TASK_SCRATCH/build/bdist" --dist-dir "$TASK_SCRATCH/wheels"
python3.12 -m venv "$TASK_SCRATCH/installed"
"$TASK_SCRATCH/installed/bin/python" -m pip install \
  "$TASK_SCRATCH/wheels/agentlink_domain_tax-0.1.0-py3-none-any.whl"
# 이 저장소에서:
cd /path/to/upper-mcp
npm run build
AGENTLINK_TEST_TAX_PYTHON="$TASK_SCRATCH/installed/bin/python" TMPDIR="$TASK_SCRATCH/tmp" npm run test:integration
AGENTLINK_TEST_TAX_PYTHON="$TASK_SCRATCH/installed/bin/python" TMPDIR="$TASK_SCRATCH/tmp" npm run test:integration:live
```

`test:integration:live`는 건너뛰기나 모의 응답 대체가 없는 필수 검사로, 실제 법령정보센터 자격증명과 네트워크를 사용해 전체 조회가 성공해야 합니다. 기본 자격증명 저장소를 쓰려면 `HOME`을 유지하고, 이미 있는 외부 자격증명 파일을 선택할 때는 파일 경로만 `AGENTLINK_CREDENTIALS_PATH`로 전달하세요. 키 값은 브리지 환경, 설정 파일, 로그에 복사하지 않습니다. 라이브 검사는 `PYTHONPATH`, `PYTHONHOME`, `AGENTLINK_TEST_TAX_REGISTRY`, `AGENTLINK_TAX_REGISTRY`, `AGENTLINK_TAX_MCP_PYTHONPATH`가 설정되어 있으면 실패하며, 자격증명·제공처 오류와 부분 조회도 실패로 처리합니다. 세무 도메인 응답의 `evidence_lookup`은 조회 상태·수·안전한 오류 코드를, `legal_evidence`는 현행 본문과 출처·해시·날짜·범위를 담습니다. 본문은 `fetched_text_not_compared`와 `current_law_not_historical` 범위로 남아 적용 판단이나 과거 시점 법령을 확정하지 않습니다.

`automation_offer`는 법률 내용이 아닌 별도 섹션이며, 연락 채널은 `not_configured`일 수 있습니다.

상태: 로컬 stdio 브리지 (원격/호스팅 미지원).

## Architecture

```
agentlink-mcp-server
├── MCP tool definitions & schemas
├── Transport layer (stdio / HTTP)
└── Optional installed domain MCP servers
        │
        ▼
Verified tool contracts are required before domain tools are advertised.
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[Apache-2.0](LICENSE)
