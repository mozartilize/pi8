# Unified selection: ma trận tham số

Tài liệu mô tả code hiện tại với `feature-v4` và `preferences.version = 1`. Không mô tả một thiết kế đề xuất. Các mốc năng lực và trọng số là policy do tác giả đặt, không phải xác suất hoàn thành task đã được hiệu chuẩn.

**Điểm quan trọng:** đây không phải một phép cộng tất cả yếu tố rồi chọn model. Thứ tự ưu tiên là:

```text
Registry + allowlist + quyền gọi
  → action = provider/model/effort
  → benchmark đúng effort + state của request
  → evidence đầy đủ trước evidence thiếu
  → capabilityShortfall nhỏ trước lớn
  → minimax regret trong cùng capability tier
  → lọc theo context để tạo dispatch chain
  → reserve và gọi provider

Rubric + đo file → D theo trục → capability targets → shortfall và fit
Phase           → relevance + required evidence   → shortfall và fit
Giá + cache + output demand                       → cost/time features
Incumbent + friction + rework                     → session features
Preferences + scenarios + weight bounds           → miền trọng số Θ
Feature intervals + Θ                            → minimax regret
```

## 1. Ma trận tổng: yếu tố nối vào bước nào?

| Yếu tố | Nguồn | Đầu ra | Tác động trước regret? | Tác động trong regret? |
|---|---|---|---|---|
| Availability, allowlist, blacklist, quota exclusions | Host và config | Pool model được phép | Có: loại khỏi pool | Không có weight |
| Manual pin, effort override, minimum thinking level | State của host | Tập action hợp lệ | Có: giới hạn model/effort | Không có weight |
| `allowedActors` | Snapshot quyền gọi | Tập action được phép | Có: lọc trước feature extraction; `[]` nghĩa là không được gọi action nào | Không có weight |
| `phase` | Declaration được chấp nhận/state hiện tại | Relevance và required evidence | Có: evidence gate; trục relevance = 0 không đóng góp shortfall | Có: nhân capability fit |
| Rubric 1–5 | Handoff hoặc execution plan được chấp nhận | Ba axis demands `D_R`, `D_A`, `D_H` | Có: quyết định mục tiêu năng lực | Có: quyết định capability fit |
| Số file, thư mục, dòng, fix commits | Router đo trên targets | Phần cộng vào `D_A` | Có, qua mục tiêu agentic | Có, qua agentic fit |
| Benchmark + provenance | Store, đúng model và effort | Quality intervals | Có: evidence gate và capabilityShortfall | Có: ba capability features, inputFit |
| Context tokens, vision input | Request hiện tại | Input relevance; predicted input cost | Có: context ảnh hưởng dispatch; evidence cho input shape | Có: inputFit và cost |
| Registry token prices | `model.cost` | Predicted USD interval | Không thay đổi tier | Có: costDesirability |
| Benchmark cost/task và output price | Benchmark đúng model | Output-demand scale | Không thay đổi tier | Có: cost và time |
| Cache evidence | Prefix identity, age, warm tokens | Cached input buckets | Không thay đổi tier | Có: cost; không cộng một cache bonus riêng |
| Output speed | Benchmark output tokens/s | Latency proxy | Không thay đổi tier | Có: timeDesirability |
| Incumbent | Exact provider/model | Continuity | Không thay đổi tier | Có: continuity; cũng dùng khi phá hòa |
| Friction | Exact model/effort/work item | Friction avoidance | Không thay đổi tier | Có: frictionAvoidance |
| Attributed rework | Failed model/effort | Hai recovery features | Không thay đổi tier | Có: effortRecoveryFit, modelSwitchRecoveryFit |
| Preferences | Năm câu trả lời trong config | Các bất đẳng thức trên θ | Không thay đổi capability targets/tier | Có: giới hạn miền trọng số Θ |
| Deadline, cancellation, snapshot validity | Selector controls | Exact/fallback/stale/cancelled | Có thể ngăn dispatch | Không phải preference hay weight |

**Preferences không được phép bù cho capabilityShortfall lớn hơn.** Evidence gate được áp dụng trước capability tier. Một action thiếu required evidence vẫn đứng sau nhóm có evidence, dù shortfall lạc quan của nó bằng 0.

## 2. Ma trận phase

Ký hiệu `R`, `A`, `H` lần lượt là relevance của reasoning, agentic và research. Đây là hệ số của feature, **không phải** các weight θ trong §5.

| Phase | R | A | H | Required benchmark evidence | Trục có thể đóng góp shortfall |
|---|---:|---:|---:|---|---|
| lightweight | 0.15 | 0 | 0.10 | Không có trục bắt buộc | Reasoning, research |
| gather | 0.40 | 0 | 1.00 | Research | Reasoning, research |
| gather, đang thu thập context read-only | 0.40 | 0 | không so sánh | Intelligence | Chỉ reasoning |
| plan | 1.00 | 0.25 | 0.50 | Intelligence | Cả ba |
| implement | 0.60 | 1.00 | 0.15 | Intelligence, agenticCoding | Cả ba |
| review | 1.00 | 0.50 | 0.80 | Intelligence | Cả ba |

Các quy tắc bổ sung:

| Điều kiện | Hiệu ứng |
|---|---|
| `state.openDecisions > 0` | `R = max(R của phase, 0.9)`; host lấy số item trong `changeFacts.declared.decisions`, khác rubric `openDecisions` 1–5 |
| `estimatedContextTokens >= 64,000` | LCR trở thành required evidence và đóng góp inputFit |
| `needsVision = true` | Vision reasoning trở thành required evidence và đóng góp inputFit |
| Có cả LCR và vision liên quan | inputFit lấy trung bình 50/50, không chuyển phần của metric thiếu sang metric có |
| Không có input aspect liên quan | inputFit = 0.5 cho mọi action, nên không tạo chênh lệch |

**Thu thập context khác gather deliverable.** Host đánh dấu thu thập context khi task type là `gather`, entry đang dùng tool read-only, và model chưa khai báo `answer`. Lúc đó reasoning target cố định 0.20, không phụ thuộc D của deliverable. `researchFit` = 0.5 cho mọi action và không tạo shortfall. Required evidence là Intelligence; LCR và vision vẫn theo quy tắc bên dưới.

Sau handoff hoặc sau khi model khai báo `answer`, dấu này hết hiệu lực. Câu trả lời gather dùng targets chung: với D chưa biết là reasoning 0.55 và research 0.65. Relevance reasoning 0.4 làm giảm điểm fit, nhưng không giảm target. Shortfall chỉ kiểm tra relevance bằng 0 hay khác 0.

Nguồn: [mapping.ts](../extensions/routing/features/mapping.ts), [model.ts](../extensions/routing/features/model.ts).

## 3. Ma trận D: rubric → demand → target

### 3.1 Chuẩn hóa rubric

`level(x) = clamp((x − 1) / 4, 0, 1)`:

| Rubric level | 1 | 2 | 3 | 4 | 5 |
|---|---:|---:|---:|---:|---:|
| Demand tương ứng | 0 | 0.25 | 0.50 | 0.75 | 1 |

Tiêu chí độc lập dùng `max`, không dùng trung bình. Tiêu chí thiếu hoặc không hợp lệ trong một rubric được parse sẽ nhận mức cao nhất trong các mức hợp lệ đã khai báo. Không có mức hợp lệ nào thì không có rubric.

Trong bảng sau, tên tiêu chí là giá trị đã qua `level()`; `m` là phần đo file ở §3.2.

| Rubric | D reasoning | D agentic | D research |
|---|---|---|---|
| Execution | max(openDecisions, knowledge, coupling) | clamp(max(openDecisions, spread, verification, coupling) + m) | max(openDecisions, knowledge) |
| Reasoning: plan/review | max(alternatives, stakes, knowledge, uncertainty) | clamp(max(spread, stakes, uncertainty) + m) | max(knowledge, uncertainty) |

| Trường hợp | Cách lấy D |
|---|---|
| Implement có active/executed execution plan kèm rubric | D từ plan và measured targets; ưu tiên hơn handoff |
| Handoff có rubric và target đúng phase đang chạy | D từ rubric và evidence của handoff |
| Handoff target khác phase | Không dùng rubric đó |
| Không có rubric phù hợp | D unknown; target dùng demand 1 |
| `difficulty.axes` có dữ liệu | Target dùng từng axis demand |
| Chỉ có `difficulty.value` | Scalar áp cho mọi trục |
| Scalar difficulty để log | max(D reasoning, D agentic, D research), không phải phép gộp để chọn model khi đã có axes |

### 3.2 Phần đo file `m`

`m = 0.05 × (fileTerm + directoryTerm + lineTerm + fixTerm)`, chỉ cộng vào agentic demand.

| Measurement | Term sau clamp [0,1] | Mức không đóng góp | Mức đóng góp tối đa | Phần cộng tối đa |
|---|---|---|---|---:|
| files | `(files − 1) / 4` | ≤1 file | ≥5 file | 0.05 |
| directories | `(directories − 1) / 3` | ≤1 thư mục | ≥4 thư mục | 0.05 |
| existingLines | `log2(max(lines,1) / 250) / 4` | ≤250 dòng | ≥4,000 dòng | 0.05 |
| fixCommits | `fixes / 5` | 0 fix | ≥5 fix | 0.05 |
| Measurement thiếu/không hữu hạn | Term = 1 | — | — | 0.05 cho measurement đó |
| Evidence `applicable = false` | m = 0 | Không có file làm evidence | — | 0 |

Tổng m tối đa 0.20. `steps`, `testTargets`, tổng `commits` không được dùng trong hàm D này.

### 3.3 Quality và targets

`target_j = easy_j + (hard_j − easy_j) × D_j`.

| Trục | Quality q chuẩn hóa, clamp [0,1] | Easy target | Hard/unknown target | Shortfall scale w |
|---|---|---:|---:|---:|
| Reasoning | Intelligence / 100 | 0.20 = Intelligence 20 | 0.55 = Intelligence 55 | 0.15 |
| Agentic | Terminal-Bench 4.0 percent / 100 | 0.01 = 1% | 0.60 = 60% | 0.20 |
| Research | 0.75 × Briefcase + 0.25 × clamp((Omniscience + 100)/200) | 0.25 | 0.65 | 0.20 |

Hai phép tính dùng cùng target nhưng có vai trò khác nhau:

| Đại lượng | Công thức | Vai trò |
|---|---|---|
| Fit của một trục | `clamp(1 − max(0, target − q)/w, 0, 1)` | Điểm năng lực đưa vào feature vector |
| Capability feature | `relevance × fit` | Điểm được nhân với θ trong regret |
| Shortfall của một trục | Relevance = 0 → 0; khác 0 → `max(0, (target − upperQuality)/w)` | Xếp capability tier; không nhân độ lớn relevance |
| Shortfall của action | max(shortfall reasoning, agentic, research) | Nhỏ hơn đứng trước; không clamp ở 1 |
| Capability tier key | Làm tròn shortfall đến 1e−9 | Gom các action có cùng mức thiếu |

Shortfall dùng **upperQuality**, không dùng central hoặc lower quality. Với quality chưa chắc chắn, upper có thể bằng 1 nên không chứng minh được thiếu năng lực. Deficit bằng 0 không phải bằng chứng chắc chắn model đủ năng lực.

Nguồn: [difficulty.ts](../extensions/routing/features/difficulty.ts), [model.ts](../extensions/routing/features/model.ts), [candidate.ts](../extensions/routing/features/candidate.ts).

## 4. Ma trận uncertainty và evidence

Quality luôn đọc từ active benchmark row đúng registryId và served effort. Không lấy chất lượng effort khác để thay thế. Intelligence chỉ được coi là evidence khi index version major.minor là `4.3`.

| Provenance của quality | Center trước fit | Lower | Upper | Có required evidence? |
|---|---|---:|---:|---|
| measured, value hợp lệ | Quality chuẩn hóa | = center | = center | Có |
| source-estimated, value hợp lệ | Quality chuẩn hóa | 0 | 1 | Có |
| regression-bridge | 0.5 | 0 | 1 | Không |
| effort-stepdown | 0.5 | 0 | 1 | Không |
| missing/row thiếu/value lỗi/version Intelligence không hỗ trợ | 0.5 | 0 | 1 | Không |

Fit được áp dụng lên cả center/lower/upper. Vì vậy central capability feature thiếu dữ liệu không nhất thiết bằng 0.5 sau transform.

| Tình huống pool | Xử lý |
|---|---|
| Có action đủ required evidence | Chỉ nhóm đó được so bằng regret; nhóm thiếu evidence ở cuối |
| Không action nào đủ required evidence | So tất cả; log `allInsufficient = true` |
| Action thiếu evidence ở cuối | Xếp theo shortfall rồi central weights trong mỗi tier; không có maxRegret |
| Nhóm đầy evidence nhưng shortfall khác nhau | Xếp tier trước; regret không so chéo tier |

## 5. Ma trận 10 features và weights

**Exact minimax regret không dùng một vector weight cố định.** Nó xét mọi θ trong miền Θ. `THETA0` dùng khi fallback chưa có domain; cũng là điểm tham chiếu để tạo representative của domain.

Mọi θ không âm, nằm trong bounds dưới đây, và `sum(θ) = 1`. Bounds không có nghĩa mọi weight có thể đồng thời ở mức tối đa.

`θrep operator` dưới đây là representative đã compile cho profile operator của campaign hai task, làm tròn 6 chữ số. Nó dùng cho central fallback, **không phải** các weight cố định của 37 lần exact solve.

| # | Feature | Giá trị/nguồn | THETA0 | Bound θ | θrep operator | Preference trực tiếp ràng buộc weight |
|---:|---|---|---:|---|---:|---|
| 0 | reasoningFit | R × reasoning fit | 0.17 | [0, 0.45] | 0.236813 | openDesignDecisions, handoffWarmCache |
| 1 | agenticFit | A × agentic fit | 0.20 | [0, 0.45] | 0.041304 | settledImplementation, researchTasks |
| 2 | researchFit | H × research fit | 0.08 | [0, 0.30] | 0.086224 | researchTasks |
| 3 | inputFit | LCR/vision trung bình khi liên quan; khác thì 0.5 | 0.05 | [0, 0.25] | 0.050000 | Không có coefficient trực tiếp |
| 4 | costDesirability | Log predicted USD | 0.30 | [0.08, 0.55] | 0.353658 | Bốn preference đầu |
| 5 | timeDesirability | Log latency proxy | 0.05 | [0, 0.20] | 0.050000 | Không có coefficient trực tiếp |
| 6 | continuity | Quan hệ với incumbent hoặc failed model | 0.09 | [0, 0.30] | 0.090000 | handoffWarmCache, afterRework |
| 7 | frictionAvoidance | Failure/friction đúng model/effort/work item | 0.04 | [0, 0.25] | 0.040000 | Không có coefficient trực tiếp |
| 8 | effortRecoveryFit | Cùng failed model, effort cao hơn: 1; khác: 0 | 0.01 | [0, 0.30] | 0.010000 | afterRework |
| 9 | modelSwitchRecoveryFit | Rework đổi khỏi failed model: 1; khác: 0 | 0.01 | [0, 0.30] | 0.042000 | afterRework |

Weight không xuất hiện trực tiếp trong một scenario vẫn liên hệ gián tiếp qua `sum(θ)=1` và bounds.

### 5.1 Session features

| Feature | Điều kiện | Giá trị |
|---|---|---:|
| continuity | Ordinary, cùng provider/model với incumbent, không xét effort | 0.65 |
| continuity | Ordinary, khác provider/model | 0.45 |
| continuity | Rework, cùng failed model và effort cao hơn | 0.78 |
| continuity | Rework, cùng failed model nhưng effort bằng/thấp hơn/không chứng minh cao hơn | 0.65 |
| continuity | Rework, khác failed model | 0.48 |
| continuity | Không xác định incumbent/boundary phù hợp | 0.50 |
| frictionAvoidance | Attributed rework trên exact model/effort/work item | 0 |
| frictionAvoidance | Severe reasoning loop trên exact model/effort/work item | 0.25 |
| frictionAvoidance | Không có attributed friction phù hợp | 1 |
| Recovery features | Ordinary boundary | Cả hai = 0 |

Nhiều friction event dùng giá trị nhỏ nhất. Unattributed friction được ghi evidence nhưng không tự giảm feature.

Nguồn: [weights.ts](../extensions/routing/optimization/weights.ts), [session.ts](../extensions/routing/features/session.ts).

## 6. Ma trận giá, cache, effort và tốc độ

### 6.1 Các mốc kinh tế

| Tham số | Giá trị | Nối vào đâu? |
|---|---:|---|
| COST_FLOOR_USD | $0.00001 | Cost ≤ mốc này có desirability 1 |
| COST_DECADES | 6 | Cost ≥ $10 có desirability 0 |
| OUTPUT_TOKENS_CENTRAL | 1,024 | Predicted output center trước demand scale |
| OUTPUT_TOKENS_MIN | 512 | Predicted output lower trước demand scale |
| OUTPUT_TOKENS_MAX | 4,096 | Predicted output upper trước demand scale |
| REFERENCE_TOKENS_PER_TASK | 100,000 | Mẫu số để chuẩn hóa output demand |
| Unknown output demand | Center 1; envelope [0.05, 12] | Mở rộng cost và time intervals |
| LATENCY_OVERHEAD_SECONDS | 2 giây | Latency proxy |
| TIME_SHAPE_SECONDS | 5 giây | Độ cong time transform |
| TIME_SATURATION_SECONDS | 300 giây | Latency ≥300 giây có desirability 0 |
| Unknown price | Center 0.5; interval [0,1] | Không giả thành giá $0 |
| Unknown/zero output speed | Center 0.5; interval [0,1] | Không giả thành nhanh |

```text
scale = (AA costPerTask / (AA outputPricePer1M / 1,000,000)) / 100,000
costFeature(USD) = clamp(1 − log10(USD / 0.00001) / 6)
latency = 2 + outputTokens / outputSpeedTps
timeFeature(t) = clamp(1 − ln(1 + t/5) / ln(1 + 300/5))
```

Scale trên là proxy output-equivalent: AA cost/task còn chứa input cost, nên không phải số output tokens đo trực tiếp.

| Evidence output demand | Quy tắc |
|---|---|
| Có cost/task và output price dương ở đúng effort | Dùng scale của row đó |
| Effort chưa có scale, có effort đo được cao hơn | Dùng effort gần nhất phía trên |
| Không có effort đo được cao hơn | Dùng scale lớn nhất đo được của cùng model |
| Cùng model không có measurement usable | Unknown demand envelope |

**Chỉ demand kinh tế được mượn giữa efforts. Quality không được mượn.** D về độ khó không nhân giá hay thời gian.

### 6.2 Công thức predicted spend

Đặt `I = estimatedContextTokens`, `W = usable warm-prefix tokens`, `pMiss = cacheWrite price nếu >0, nếu không thì input price`. Các price đổi từ $/M tokens sang $/token.

```text
centralUSD = W × pReadCentral + (I − W) × pMiss + 1,024 × scale × pOutput
minUSD     = W × pReadLow     + (I − W) × pMiss +   512 × low   × pOutput
maxUSD     = I × pMiss                         + 4,096 × high  × pOutput
```

| Cache/price input | Cách xử lý |
|---|---|
| Không có pricing hoặc input/output price không usable | Price unknown |
| Giá input/output bằng 0, hợp lệ | Known price; có thể free |
| cacheRead price thiếu | Center không có cache discount; lower dùng read price 0 |
| cacheWrite price >0 | Cold input tính ở write price thay input price, không tính hai lần |
| Cache source none, sai promptIdentity, quá TTL hoặc subagent spawn | W = 0 |
| Action đúng cached incumbentKey | W = toàn bộ I |
| Cùng incumbent model, đổi effort và có shared cache | W = toàn bộ I |
| Action khác | W = min(I, warm tokens đã ghi cho action đó) |
| Shared cache giữa efforts | Chỉ khi API = anthropic-messages và supportsMidConvoEffort = true |
| Cache TTL | Feature nhận từ cache state; production provider truyền 5 phút (`5 × 60,000 ms`) |

Cost transform giảm theo USD: lower cost feature lấy `costFeature(maxUSD)`, upper lấy `costFeature(minUSD)`.

Host có thể bổ sung warm-prefix credits từ model history khi `reputation` không bị tắt. Sau đó feature dùng warm tokens và prompt identity đã chuẩn bị, không đọc reputation như một weight riêng.

Production dùng registry prices, kể cả provider subscription. Không có phí tháng, remaining quota hay `apiCostModels` trong công thức. Trường price tiers không được đọc trong `predictSpend()`; hàm này dùng các price fields ở cấp trên.

Nguồn: [economics.ts](../extensions/routing/features/economics.ts), [candidate.ts](../extensions/routing/features/candidate.ts).

## 7. Ma trận preferences → constraints → miền Θ

Năm câu trả lời **cùng ràng buộc một miền Θ dùng cho mọi phase**. Tên `settledImplementation` không có nghĩa constraint này chỉ bật khi phase = implement.

Mỗi scenario có hai hypothetical feature vectors A/B cố định. Benchmark live và cache live không thay đổi scenario. Các feature bằng nhau giữa A/B triệt tiêu; chỉ các delta khác 0 mới xuất hiện dưới đây.

Ký hiệu `r,a,h,c,n,e,m` là weight của reasoning, agentic, research, cost, continuity, effortRecovery và modelSwitchRecovery.

| Preference | Option A | Option B | Δ = features(A) − features(B), bỏ các cột bằng 0 | Operator chọn |
|---|---|---|---|---|
| settledImplementation | lower_cost ($0.07) | higher_coding_capability ($0.10) | `−0.10a + 0.025817c` | A |
| openDesignDecisions | lower_cost ($0.05) | higher_reasoning_capability ($0.10) | `−0.19r + 0.050172c` | B |
| handoffWarmCache | keep_warm_incumbent ($0.04) | switch_for_capability ($0.15) | `−0.24r + 0.095672c + 0.20n` | B |
| researchTasks | lower_cost ($0.06) | higher_research_capability ($0.12) | `+0.18a − 0.35h + 0.050172c` | B |
| afterRework | increase_effort ($0.10) | switch_model ($0.10) | `+0.30n + 1e − 1m` | B |

| Câu trả lời | Constraint |
|---|---|
| A | `θ·Δ >= 0.005` |
| B | `θ·(−Δ) >= 0.005` |
| equivalent | `abs(θ·Δ) <= 0.005` |
| unsure / skip / không trả lời | Không thêm constraint |
| Profile invalid / unsupported version | Không áp một phần profile; dùng labeled central fallback |

Với operator, năm constraints cụ thể là:

```text
−0.10a + 0.025817c                         >= 0.005
+0.19r − 0.050172c                        >= 0.005
+0.24r − 0.095672c − 0.20n                >= 0.005
−0.18a + 0.35h − 0.050172c                >= 0.005
−0.30n − 1e + 1m                         >= 0.005
```

Ví dụ preference lower_cost cho settledImplementation ép một quan hệ giữa cost weight và agentic weight. Nó không đặt `cost weight = 1`, không chỉ định model và không cho phép bỏ capability target.

### 7.1 Domain compilation

| Trạng thái | Miền Θ | Representative dùng khi fallback |
|---|---|---|
| Không substantive answers | ThetaBase = bounds + sum θ = 1 | THETA0 |
| Answers khả thi với ThetaBase | Thêm hard constraints | Điểm gần THETA0 nhất trong L1 |
| Answers không khả thi trong biểu diễn này | Một slack không âm/answer; giữ các điểm có tổng slack trong minimum + 1e−7 | Điểm gần THETA0 nhất trong miền min-slack |
| Có answers nhưng artifact chưa ready | Chưa áp answer constraints | THETA0; constraintsEnforced=false |
| Artifact ready nhưng selection solver lỗi/timeout | Giữ domain của profile | θ representative; constraintsEnforced=true |

Slack penalty = 1 cho mọi answer. Representative có tie-break xác định: minimize từng θ theo thứ tự feature, dùng tolerance 1e−8 trong các bước cố định nghiệm. Representative không thu hẹp miền dùng cho exact regret.

Artifact identity phụ thuộc profile, scenario digest, feature schema, base bounds/anchor, choice margin, equivalence tolerance và slack penalty. Artifact sai identity/digest hoặc representative ngoài domain bị từ chối.

Nguồn: [scenarios.ts](../extensions/routing/preferences/scenarios.ts), [fit.ts](../extensions/routing/preferences/fit.ts), [domain.ts](../extensions/routing/optimization/domain.ts).

## 8. Ma trận regret và fallback

Trong **một capability tier**, với action a và đối thủ b:

```text
U(a, θ)  = θ · featureVector(a)
PR(a,b)  = max[θ thuộc Θ] θ · (upperFeatures(b) − lowerFeatures(a))
PR(a,a)  = 0
MR(a)    = max[b trong cùng tier] max(0, PR(a,b))
chosen   = action có MR nhỏ nhất trong tier đầu tiên
```

Ý nghĩa: chọn action có mức thua thiệt lớn nhất nhỏ nhất, khi weights và feature values nằm trong miền uncertainty được phép. Không phải chọn action có weighted average lớn nhất.

| Quy tắc/tham số | Giá trị | Hiệu ứng |
|---|---|---|
| Primary ranking | Evidence group → shortfall tier → MR | Giá không thắng qua evidence/tier |
| Tie MR | Chênh ≤1e−7 coi là hòa | Higher continuity → lower known USD → canonical key |
| USD tie tolerance | 1e−12 | Known price đứng trước unknown khi cần phá hòa |
| Self-pair | PR(a,a)=0 | Tier có một action có MR=0, dù feature uncertain |
| Regret giữa các tiers | Không so trực tiếp | MR=0 ở tier xấu không thắng MR>0 ở tier tốt |
| Base domain | Closed-form box + simplex maximum | Exact, không cần LP solve |
| Constrained domain | LP cho pair objectives | Mỗi pair có thể có θ tối ưu khác nhau |
| LP_CHUNK | 16 objectives | Batching; không đổi công thức |
| Pruning | Upper-vector dominance và ThetaBase upper bounds | Giảm LP work; giữ action trong ranking |
| LP residual tolerance | 1e−7 | Verify feasibility/objective, tie comparisons và stopping checks |
| LP upper-bound check tolerance | `1e−7 × (1 + sum(abs(objective)))` | Phát hiện LP result vượt bound lý thuyết |
| Production deadline | 500 ms | Shared deadline cho selection; LP timeout → central fallback |
| Production pair cap | Không có | Không tự bỏ candidates theo số pair |
| Spike-only budget | 200 ms; pairCap 4,096 | Tham số measurement/test, không phải production policy |
| Spike pair count | n×(n−1) của toàn compared group | Vượt cap → central fallback |
| Central fallback | max `θrep·centerFeatures` trong từng tier | Không phải exact regret; vẫn giữ tier order |
| Artifact missing/invalid | Central với THETA0 | constraintsEnforced=false |
| Cancellation/snapshot stale | cancelled ưu tiên hơn stale | Không dispatch một lựa chọn cũ |

Fallback reasons: `timeout`, `spike-pair-cap`, `numerical`, `no-solver`, `domain-not-ready`, `domain-error`, `unsupported-version`.

500 ms là deadline được truyền vào solver, không phải hard timeout bao quanh toàn bộ JavaScript. Base closed-form và các phần tính đồng bộ không tự yield chỉ vì deadline đã qua.

Nguồn: [select.ts](../extensions/routing/optimization/select.ts), [regret.ts](../extensions/routing/optimization/regret.ts).

## 9. Ranking không đồng nghĩa dispatch chain

| Bước | Xử lý |
|---|---|
| Enumerate actions | Các efforts Pi hỗ trợ: off, minimal, low, medium, high, xhigh, max; không yêu cầu phải có benchmark |
| Effort aliases | Các levels gửi cùng provider value gom thành một action |
| Effort override | Pi clamp rồi chọn alias group tương ứng |
| Full ranking | Giữ toàn bộ legal actions, gồm tiers yếu và evidence thiếu |
| Dispatch chain | Chỉ action có context window chứa prompt hiện tại; mỗi provider/model chỉ giữ effort đứng đầu còn phù hợp |
| Better action không chứa prompt | Giữ trong ranking để context preparation có thể yêu cầu compaction |
| Provider fallback | Advance chain nếu failure xảy ra trước output có thể nhìn thấy; khác solver fallback |
| Reservation | Quyền gọi một lần, kiểm tra revisions trước provider request; không phải weight |

Vision filter trong adapter giữ các model hỗ trợ image nếu pool có model như vậy. Filter này khác vision benchmark evidence và inputFit.

Debug ghi mọi ranked action. Không debug ghi top 12 cộng chosen/incumbent nếu cần. Trace numbers làm tròn 1e−5, nên đọc tier/regret từ log cần lưu ý precision. Trường `theta` có ở central fallback; exact selection không có một vector θ cố định để log.

Nguồn: [actions.ts](../extensions/routing/features/actions.ts), [unified-decision.ts](../extensions/serve/unified-decision.ts).

## 10. Ví dụ liên hệ các bảng

### Thu thập context, D chưa biết

```text
phase = gather, đang thu thập context read-only, chưa khai báo answer
reasoning target = 0.20 (D vẫn ghi là unknown)
researchFit = 0.5 cho mọi action, không có research shortfall
required evidence = Intelligence
→ nhiều action cùng tier; cost và preferences quyết định trong tier
```

### Câu trả lời gather, D chưa biết

```text
phase = gather, sau khi khai báo answer
relevance = reasoning 0.4, agentic 0, research 1
D unknown → targets = reasoning 0.55, agentic 0.60, research 0.65
agentic relevance = 0 → bỏ agentic shortfall
→ chia tiers trước khi xét cost weight hay preferences
```

Tăng cost weight không thể khiến một action rẻ thắng một action thuộc tier tốt hơn. Đổi relevance reasoning từ 0.4 xuống 0.1 cũng không giảm target hay shortfall của reasoning. Chỉ đặt relevance = 0 mới bỏ trục đó khỏi shortfall.

### Implement có axes {0.50, 0.65, 0.50}

| Đại lượng | Reasoning | Agentic | Research |
|---|---:|---:|---:|
| D | 0.50 | 0.65 | 0.50 |
| Target | 0.375 | 0.3935 | 0.45 |
| Benchmark tương đương | Intelligence 37.5 | Terminal-Bench 39.35% | Combined research 0.45 |
| Phase relevance | 0.6 | 1 | 0.15 |

D summary là 0.65 nhưng reasoning target không dùng D=0.65. Các trục dùng D riêng. Nếu một số action đạt mọi target, chỉ những action có deficit 0 cạnh tranh để thắng; cost, cache, continuity và preference phân biệt chúng trong regret.

## 11. Những tham số không nối trực tiếp vào regret

| Tham số/thông tin | Trạng thái trong selector hiện tại |
|---|---|
| Rubric requirement formulas trong policy/execution-difficulty.ts | Không phải công thức D của feature-v4; feature difficulty dùng file riêng |
| Legacy capability bands/minimum tables | Không phải biến trong objective regret này |
| Legacy dimensionWeights | Không thay thế PHASE_RELEVANCE hoặc THETA_BOUNDS trong selector này |
| complexity/scope, facts, yêu cầu tự nhiên | Không được regret đọc trực tiếp; phải được thể hiện qua state/rubric/permissions trước selection |
| Prompt dài hơn | Tăng predicted input cost; có thể bật LCR relevance/evidence và ảnh hưởng dispatch capacity; không trực tiếp nâng D |
| Subscription fee và remaining quota | Không có trong cost feature; usage-limit failure có thể làm host loại provider |
| Profile name operator/cost-all/capability-all | Tên của campaign; selector đọc câu trả lời, không đọc tên profile để chọn công thức |

## 12. Cách đọc một decision log

Đọc theo thứ tự này, không bắt đầu bằng weight vector:

1. `ranked`, `holdingPrompt`, permissions: action nào còn được gọi?
2. `evidenceGaps`, `insufficientEvidence`: action nào được so bằng regret?
3. `difficultyAxes`, phase và target mapping: đang yêu cầu năng lực gì?
4. `capabilityShortfall`: candidates có cùng tier không?
5. `solver`, `domainStatus`, `constraintsEnforced`: preferences đã được áp chưa?
6. `maxRegret`: chỉ so candidates cùng tier; hoặc `centralScore` nếu fallback.
7. `costUsd`, features, continuity và cache evidence: vì sao khác nhau trong tier?
8. `served`, provider failure và fallback rank: model nào thực sự phục vụ?

Xem thêm [Routing](routing.md) và [Glossary](glossary.md).
