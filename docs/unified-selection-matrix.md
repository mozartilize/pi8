# Unified selection: ma trận tham số

Tài liệu mô tả code hiện tại với `feature-v11` và `preferences.version = 1`. Không mô tả một thiết kế đề xuất. Các mốc năng lực và trọng số là policy do tác giả đặt, không phải xác suất hoàn thành task đã được hiệu chuẩn.

**Điểm quan trọng:** guards quyết định action nào được phép gọi. Mọi action được phép nằm trong một pool so sánh duy nhất. Thứ tự xử lý là:

```text
Registry + allowlist + quyền gọi
  → action = provider/model/effort
  → benchmark đúng effort + state của request
  → feature intervals (quality thiếu evidence → interval [0, 1])
  → minimax regret trên toàn pool (hoặc central fallback trên cùng pool)
  → lọc theo context để tạo dispatch chain
  → reserve và gọi provider

Rubric + đo file → D theo trục → capability targets → shortfall và fit
Phase           → relevance + required evidence   → fit; shortfall và evidence gaps chỉ là diagnostics
Giá + cache + output demand                       → cost/time features
Incumbent + friction + rework                     → session features
Preferences + scenarios + weight bounds           → miền trọng số Θ
Feature intervals + Θ                            → minimax regret
```

## 0. Các phép biến đổi và module sở hữu

Mỗi phép biến đổi có một module sở hữu. Module chỉ đọc snapshot của nó (`extensions/routing/features/state.ts`); snapshot là kiểu chỉ đọc ở mọi tầng. Một field không có trong snapshot không thể đổi kết quả của module.

| Phép biến đổi | Module | Đầu vào | Đầu ra |
|---|---|---|---|
| Liệt kê action | `features/actions.ts` | Registry model | `provider/model/effort` hợp lệ |
| Task demand | `features/task-demand.ts` | `TaskDeclarations` + `WorkloadMeasurement` | Relevance, demand intervals, targets, required evidence |
| Capability | `features/model.ts` | Task demand + benchmark row đúng effort + `BenchmarkSnapshot` | Bốn capability features, shortfall, evidence gaps |
| Benchmark output | `features/benchmark-output.ts` | Benchmark row đúng effort + index version | AA output tokens/task (`measured`) hoặc reason thiếu (`missing`) |
| Cache | `features/cache.ts` | `SpendSnapshot` + `PriceSnapshot` | Warm prefix và cache eligibility |
| Spend | `features/spend.ts` | `SpendSnapshot` + `PriceSnapshot` + benchmark output | Billing buckets, economic cost proxy (USD), cost feature |
| Latency | `features/latency.ts` | Output speed + benchmark output | Time feature |
| Continuity | `features/continuity.ts` | `SessionSnapshot` | Continuity feature |
| Recovery | `features/recovery.ts` | `SessionSnapshot` | Friction avoidance và hai recovery features |
| Feature vector | `features/candidate.ts` | `DecisionStateV1` (adapter duy nhất cấp các snapshot) | Vector 10 features có evidence |
| Miền trọng số | `optimization/domain.ts` | Preferences đã validate + scenarios | Weight domain Θ |
| Bài toán số | `optimization/compile.ts` | Feature vectors + policy hòa | `DecisionProblem` đã validate, action lỗi tách riêng |
| Minimax regret | `optimization/minimax.ts` | `DecisionProblem` + Θ | Max regret, ranking |
| Chọn action | `optimization/select.ts` | Pool được phép + preferences + controls | Decision exact, fallback có nhãn, stale hoặc cancelled |

## 1. Ma trận tổng: yếu tố nối vào bước nào?

| Yếu tố | Nguồn | Đầu ra | Tác động trước regret? | Tác động trong regret? |
|---|---|---|---|---|
| Availability, allowlist, blacklist, quota exclusions | Host và config | Pool model được phép | Có: loại khỏi pool | Không có weight |
| Manual pin, effort override, minimum thinking level | State của host | Tập action hợp lệ | Có: giới hạn model/effort | Không có weight |
| `allowedActors` | Snapshot quyền gọi | Tập action được phép | Có: lọc trước feature extraction; `[]` nghĩa là không được gọi action nào | Không có weight |
| `phase` | Declaration được chấp nhận/state hiện tại | Relevance và required evidence | Không: required evidence chỉ là diagnostic | Có: nhân capability fit |
| Rubric 1–5 | Handoff hoặc execution plan được chấp nhận | Ba axis demands `D_R`, `D_A`, `D_H` | Không: chỉ đặt targets | Có: quyết định capability fit |
| Số file, thư mục, dòng, fix commits | Router đo trên targets | Phần cộng vào `D_A` | Không | Có, qua agentic fit |
| Benchmark + provenance | Store, đúng model và effort | Quality intervals | Không: evidence gaps và capabilityShortfall chỉ là diagnostics | Có: ba capability features, inputFit |
| Context tokens, vision input | Request hiện tại | Input relevance; prompt cost | Có: context ảnh hưởng dispatch; evidence cho input shape | Có: inputFit và cost |
| Registry token prices | `model.cost` | USD interval của economic cost proxy | Không | Có: costDesirability |
| AA output tokens/task | Benchmark đúng model và đúng effort | Benchmark output cost và time, dùng nguyên giá trị | Không | Có: cost và time |
| Cache evidence | Prefix identity, age, warm tokens | Cached input buckets | Không | Có: cost; không cộng một cache bonus riêng |
| Output speed | Benchmark output tokens/s | Benchmark-output time proxy | Không | Có: timeDesirability |
| Incumbent | Exact provider/model | Continuity | Không | Có: continuity; cũng dùng khi phá hòa |
| Friction | Exact model/effort/work item | Friction avoidance | Không | Có: frictionAvoidance |
| Attributed rework | Failed model/effort | Hai recovery features | Không | Có: effortRecoveryFit, modelSwitchRecoveryFit |
| Preferences | Năm câu trả lời trong config | Các bất đẳng thức trên θ | Không thay đổi capability targets | Có: giới hạn miền trọng số Θ |
| Deadline, cancellation, snapshot validity | Selector controls | Exact/fallback/stale/cancelled | Có thể ngăn dispatch | Không phải preference hay weight |

**Không có capability tier và không có evidence tail.** Mọi action được phép cạnh tranh trong cùng một pool. Capability chỉ đi vào so sánh qua capability features; preferences quyết định mức đánh đổi giữa capability fit, giá, tốc độ và continuity. `capabilityShortfall` và `evidenceGaps` chỉ là diagnostics: không lọc, không gom nhóm, không xếp hạng và không phá hòa.

## 2. Ma trận phase

Ký hiệu `R`, `A`, `H` lần lượt là relevance của reasoning, agentic và research. Đây là hệ số của feature, **không phải** các weight θ trong §5.

| Phase | R | A | H | Required benchmark evidence (diagnostic) | Trục có thể đóng góp shortfall (diagnostic) |
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

Nguồn: [task-demand.ts](../extensions/routing/features/task-demand.ts), [model.ts](../extensions/routing/features/model.ts).

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
| Shortfall của một trục | Relevance = 0 → 0; khác 0 → `max(0, (target − upperQuality)/w)` | Diagnostic; không nhân độ lớn relevance |
| Shortfall của action | max(shortfall reasoning, agentic, research) | Diagnostic trong log; không clamp ở 1; không xếp hạng |

Shortfall dùng **upperQuality**, không dùng central hoặc lower quality. Với quality chưa chắc chắn, upper có thể bằng 1 nên không chứng minh được thiếu năng lực. Deficit bằng 0 không phải bằng chứng chắc chắn model đủ năng lực.

Nguồn: [difficulty.ts](../extensions/routing/features/difficulty.ts), [model.ts](../extensions/routing/features/model.ts), [candidate.ts](../extensions/routing/features/candidate.ts).

## 4. Ma trận uncertainty và evidence

Quality luôn đọc từ active benchmark row đúng registryId và served effort. Không lấy chất lượng effort khác để thay thế. Intelligence chỉ được coi là evidence khi index version major.minor là `4.3`.

| Provenance của quality | Center trước fit | Lower | Upper | Có required evidence? (diagnostic) |
|---|---|---:|---:|---|
| measured, value hợp lệ | Quality chuẩn hóa | = center | = center | Có |
| source-estimated, value hợp lệ | Quality chuẩn hóa | 0 | 1 | Có |
| regression-bridge | 0.5 | 0 | 1 | Không |
| effort-stepdown | 0.5 | 0 | 1 | Không |
| missing/row thiếu/value lỗi/version Intelligence không hỗ trợ | 0.5 | 0 | 1 | Không |

Fit được áp dụng lên cả center/lower/upper. Vì vậy central capability feature thiếu dữ liệu không nhất thiết bằng 0.5 sau transform.

| Tình huống pool | Xử lý |
|---|---|
| Có action thiếu required evidence | Vẫn so trong cùng pool; quality thiếu dùng interval [0, 1]; có maxRegret; liệt kê trong `insufficientEvidence` |
| Không action nào đủ required evidence | So tất cả như thường; log `allInsufficient = true` |
| Shortfall khác nhau | Không ảnh hưởng thứ tự; regret so chéo toàn pool |
| Missing và source-estimated với cùng bounds | Exact MR bằng nhau; central fallback có thể khác vì center khác |

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
| 4 | costDesirability | Log economic cost proxy (USD) | 0.30 | [0.08, 0.55] | 0.353658 | Bốn preference đầu |
| 5 | timeDesirability | Log benchmark-output time proxy | 0.05 | [0, 0.20] | 0.050000 | Không có coefficient trực tiếp |
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

Nguồn: [weights.ts](../extensions/routing/optimization/weights.ts), [continuity.ts](../extensions/routing/features/continuity.ts), [recovery.ts](../extensions/routing/features/recovery.ts).

## 6. Ma trận giá, cache, effort và tốc độ

### 6.1 Các mốc kinh tế

| Tham số | Giá trị | Nối vào đâu? |
|---|---:|---|
| COST_FLOOR_USD | $0.00001 | Cost ≤ mốc này có desirability 1 |
| COST_DECADES | 6 | Cost ≥ $10 có desirability 0 |
| TIME_SHAPE_SECONDS | 60 giây | Độ cong time transform |
| TIME_SATURATION_SECONDS | 3,600 giây | Time proxy ≥3,600 giây có desirability 0 |
| Unknown price | Center 0.5; interval [0,1] | Không giả thành giá $0 |
| Unknown/zero output speed, có speed ở effort khác cùng registry model | Time bounds từ min/max speed của các row active; center là trung điểm | `speed-other-effort`: ước tính, không phải giới hạn bảo đảm |
| Không có output speed dùng được ở cùng registry model | Center 0.5; interval [0,1] | Không giả thành nhanh |
| Thiếu output tokens/task, output price >0 | Cost: [0, costFeature(minUSD)], center là trung điểm | Không giả một số token |
| Thiếu output tokens/task, speed đã biết | Time: center 0.5; interval [0,1] | Không giả một số token |

```text
benchmarkOutputUSD = AA outputTokensPerTask × pOutput
costFeature(USD) = clamp(1 − log10(USD / 0.00001) / 6)
benchmarkOutputSeconds = AA outputTokensPerTask / outputSpeedTps
timeFeature(t) = clamp(1 − ln(1 + t/60) / ln(1 + 3600/60))
```

AA output tokens/task là quan sát trên một benchmark task, không phải dự báo output của invocation kế tiếp. Router dùng nguyên giá trị đó: không có mốc tham chiếu, không giới hạn, không thống kê của pool. Cost và time chỉ dùng các phép biến đổi tuyệt đối cố định, nên feature của một action không đổi khi một action khác vào hoặc rời pool. Time proxy không phải wall time của task AA và không phải latency của invocation kế tiếp.

| Evidence output tokens | Quy tắc |
|---|---|
| Row đúng effort có observation `measured`, page và API index version tương thích | Dùng nguyên token count của row đó; evidence `output-tokens:measured` |
| Thiếu row, thiếu observation, `source-estimated`, `unknown-effort`, `invalid`, `conflict`, version không rõ hoặc không tương thích | Không có token count; evidence `output-tokens:<reason>` |

Coverage trên `fixtures/real-pool.json` (index 4.3, bỏ provider `cursor`): 769 effective actions. 282 action (36,7%) có token count `measured`. 64 action có benchmark row đúng effort nhưng row không có observation (`absent`). 423 action không có benchmark row đúng effort (`no-row`). Không action nào bị loại vì `source-estimated`, `unknown-effort`, `invalid`, `conflict` hoặc version. Số liệu này đổi khi fixture được tạo lại.

`real-pool-sensitivity.test.ts` kiểm tra trên real pool, với domain base và domain operator: thiếu output tokens, giá hoặc output speed không làm giảm max regret của action bị ảnh hưởng; warm prefix còn hạn không làm tăng max regret của incumbent; mọi action được phép vẫn ở trong ranking.

**Không mượn output tokens hoặc quality giữa efforts hay giữa models.** D về độ khó không nhân giá hay thời gian.

### 6.2 Công thức economic cost proxy

Đặt `I = estimatedContextTokens`, `W = usable warm-prefix tokens`, `pMiss = cacheWrite price nếu >0, nếu không thì input price`, `O = benchmarkOutputUSD`. Các price đổi từ $/M tokens sang $/token. Prompt cost là của request hiện tại; O là của một benchmark task. Tổng là routing proxy, không phải spend của invocation kế tiếp.

```text
centralUSD = W × pReadCentral + (I − W) × pMiss + O
minUSD     = min(miss, hit với pReadLow)        + O
maxUSD     = max(miss, hit với pReadCentral)    + O
```

| Cache/price input | Cách xử lý |
|---|---|
| Không có pricing hoặc input/output price không usable | Price unknown |
| Giá input/output bằng 0, hợp lệ | Known price; có thể free |
| Output price = 0 | O = 0, kể cả khi thiếu output tokens/task |
| Output price >0 và thiếu output tokens/task | Chỉ có minUSD (prompt cost, O = 0); không có centralUSD, maxUSD |
| cacheRead price thiếu | Center không có cache discount; lower dùng read price 0 |
| cacheWrite price >0 | Cold input tính ở write price thay input price, không tính hai lần |
| Cache source none, sai promptIdentity, hoặc quá TTL | W = 0 |
| Action đúng cached incumbentKey | W = toàn bộ I |
| Cùng incumbent model, đổi effort và có shared cache | W = toàn bộ I |
| Action khác | W = min(I, warm tokens đã ghi cho action đó) |
| Shared cache giữa efforts | Chỉ khi API = anthropic-messages và supportsMidConvoEffort = true |
| Cache TTL | Feature nhận từ cache state; production provider truyền 5 phút (`5 × 60,000 ms`) |

Cost transform giảm theo USD: lower cost feature lấy `costFeature(maxUSD)`, upper lấy `costFeature(minUSD)`. Không có maxUSD thì lower = 0.

Host có thể bổ sung warm-prefix credits từ model history khi `reputation` không bị tắt. Sau đó feature dùng warm tokens và prompt identity đã chuẩn bị, không đọc reputation như một weight riêng.

Production dùng registry prices, kể cả provider subscription. Không có phí tháng, remaining quota hay `apiCostModels` trong công thức. Khi registry có price tiers, tier có ngưỡng cao nhất mà số prompt token bị tính phí vượt qua định giá toàn bộ request.

Nguồn: [benchmark-output.ts](../extensions/routing/features/benchmark-output.ts), [cache.ts](../extensions/routing/features/cache.ts), [spend.ts](../extensions/routing/features/spend.ts), [latency.ts](../extensions/routing/features/latency.ts), [candidate.ts](../extensions/routing/features/candidate.ts).

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

Trên **toàn bộ pool được phép**, với action a và đối thủ b:

```text
U(a, θ)  = θ · featureVector(a)
PR(a,b)  = max[θ thuộc Θ] θ · (upperFeatures(b) − lowerFeatures(a))
PR(a,a)  = 0
MR(a)    = max[b trong pool] max(0, PR(a,b))
chosen   = action có MR nhỏ nhất
```

Ý nghĩa: chọn action có mức thua thiệt lớn nhất nhỏ nhất, khi weights và feature values nằm trong miền uncertainty được phép. Không phải chọn action có weighted average lớn nhất.

| Quy tắc/tham số | Giá trị | Hiệu ứng |
|---|---|---|
| Primary ranking | MR trên toàn pool | Shortfall và evidence gaps không ảnh hưởng thứ tự |
| Tie MR | Chênh ≤1e−7 coi là hòa | Higher continuity → lower known USD → canonical key |
| USD tie tolerance | 1e−12 | Known price đứng trước unknown khi cần phá hòa |
| Self-pair | PR(a,a)=0 | Pool có một action có MR=0, dù feature uncertain |
| `regretScope: pool` | Có trong exact decision metadata | MR so được giữa mọi ranked action; record không có trường này có thể chứa MR chỉ so được giữa các action cùng shortfall |
| Base domain | Closed-form box + simplex maximum | Exact, không cần LP solve |
| Constrained domain | LP cho pair objectives | Mỗi pair có thể có θ tối ưu khác nhau |
| LP_CHUNK | 16 objectives | Batching; không đổi công thức |
| Pruning | Upper-vector dominance và ThetaBase upper bounds | Giảm LP work; giữ action trong ranking |
| LP residual tolerance | 1e−7 | Verify feasibility/objective, tie comparisons và stopping checks |
| LP upper-bound check tolerance | `1e−7 × (1 + sum(abs(objective)))` | Phát hiện LP result vượt bound lý thuyết |
| Production deadline | 500 ms | Shared deadline cho selection; LP timeout → central fallback |
| Production pair cap | Không có | Không tự bỏ candidates theo số pair |
| Spike-only budget | 200 ms; pairCap 4,096 | Tham số measurement/test, không phải production policy |
| Spike pair count | n×(n−1) của toàn pool | Vượt cap → central fallback |
| Central fallback | max `θrep·centerFeatures` trên cùng pool | Không phải exact regret; không có tier order |
| Artifact missing/invalid | Central với THETA0 | constraintsEnforced=false |
| Cancellation/snapshot stale | cancelled ưu tiên hơn stale | Không dispatch một lựa chọn cũ |

Fallback reasons: `timeout`, `spike-pair-cap`, `numerical`, `no-solver`, `domain-not-ready`, `domain-error`, `unsupported-version`.

500 ms là deadline được truyền vào solver, không phải hard timeout bao quanh toàn bộ JavaScript. Base closed-form và các phần tính đồng bộ không tự yield chỉ vì deadline đã qua.

Nguồn: [select.ts](../extensions/routing/optimization/select.ts), [compile.ts](../extensions/routing/optimization/compile.ts), [minimax.ts](../extensions/routing/optimization/minimax.ts).

## 9. Ranking không đồng nghĩa dispatch chain

| Bước | Xử lý |
|---|---|
| Enumerate actions | Các efforts Pi hỗ trợ: off, minimal, low, medium, high, xhigh, max; không yêu cầu phải có benchmark |
| Effort aliases | Các levels gửi cùng provider value gom thành một action |
| Effort override | Pi clamp rồi chọn alias group tương ứng |
| Full ranking | Giữ toàn bộ legal actions, gồm action có shortfall và action thiếu evidence |
| Dispatch chain | Chỉ action có context window chứa prompt hiện tại; mỗi provider/model chỉ giữ effort đứng đầu còn phù hợp |
| Better action không chứa prompt | Giữ trong ranking để context preparation có thể yêu cầu compaction |
| Provider fallback | Advance chain nếu failure xảy ra trước output có thể nhìn thấy; khác solver fallback |
| Reservation | Quyền gọi một lần, kiểm tra revisions trước provider request; không phải weight |

Vision filter trong adapter giữ các model hỗ trợ image nếu pool có model như vậy. Filter này khác vision benchmark evidence và inputFit.

Debug ghi mọi ranked action. Không debug ghi top 12 cộng chosen/incumbent nếu cần. Trace numbers làm tròn 1e−5, nên đọc regret từ log cần lưu ý precision. Trường `theta` có ở central fallback; exact selection không có một vector θ cố định để log.

Nguồn: [actions.ts](../extensions/routing/features/actions.ts), [unified-decision.ts](../extensions/serve/unified-decision.ts).

## 10. Ví dụ liên hệ các bảng

### Thu thập context, D chưa biết

```text
phase = gather, đang thu thập context read-only, chưa khai báo answer
reasoning target = 0.20 (D vẫn ghi là unknown)
researchFit = 0.5 cho mọi action, không có research shortfall
required evidence = Intelligence
→ reasoning fit dễ đạt; cost và preferences thường quyết định
```

### Câu trả lời gather, D chưa biết

```text
phase = gather, sau khi khai báo answer
relevance = reasoning 0.4, agentic 0, research 1
D unknown → targets = reasoning 0.55, agentic 0.60, research 0.65
agentic relevance = 0 → agentic không đóng góp feature hay shortfall
→ action thiếu target có fit thấp hơn; miền Θ quyết định mức đánh đổi với cost
```

Miền Θ cost-oriented có thể khiến một action rẻ, thiếu nhẹ reasoning target, thắng một action đắt đạt target. Miền Θ capability-oriented có thể đảo ngược kết quả đó. Đổi relevance reasoning từ 0.4 xuống 0.1 không giảm target; nó giảm độ lớn của reasoning feature.

### Implement có axes {0.50, 0.65, 0.50}

| Đại lượng | Reasoning | Agentic | Research |
|---|---:|---:|---:|
| D | 0.50 | 0.65 | 0.50 |
| Target | 0.375 | 0.3935 | 0.45 |
| Benchmark tương đương | Intelligence 37.5 | Terminal-Bench 39.35% | Combined research 0.45 |
| Phase relevance | 0.6 | 1 | 0.15 |

D summary là 0.65 nhưng reasoning target không dùng D=0.65. Các trục dùng D riêng. Mọi action cạnh tranh trong regret; action đạt target có full fit, còn cost, cache, continuity và preferences quyết định mức đánh đổi với action thiếu target.

## 11. Những tham số không nối trực tiếp vào regret

| Tham số/thông tin | Trạng thái trong selector hiện tại |
|---|---|
| Rubric requirement formulas trong policy/execution-difficulty.ts | Không phải công thức D của feature mapping; feature difficulty dùng file riêng |
| Legacy capability bands/minimum tables | Không phải biến trong objective regret này |
| Legacy dimensionWeights | Không thay thế PHASE_RELEVANCE hoặc THETA_BOUNDS trong selector này |
| complexity/scope, facts, yêu cầu tự nhiên | Không được regret đọc trực tiếp; phải được thể hiện qua state/rubric/permissions trước selection |
| Prompt dài hơn | Tăng predicted input cost; có thể bật LCR relevance/evidence và ảnh hưởng dispatch capacity; không trực tiếp nâng D |
| Subscription fee và remaining quota | Không có trong cost feature; usage-limit failure có thể làm host loại provider |
| Profile name operator/cost-all/capability-all | Tên của campaign; selector đọc câu trả lời, không đọc tên profile để chọn công thức |

## 12. Cách đọc một decision log

Đọc theo thứ tự này, không bắt đầu bằng weight vector:

1. `ranked`, `holdingPrompt`, permissions: action nào còn được gọi?
2. `evidenceGaps`, `insufficientEvidence`: action nào có quality interval rộng vì thiếu evidence? (diagnostic, không loại action)
3. `difficultyAxes`, phase và target mapping: đang yêu cầu năng lực gì?
4. `capabilityShortfall`: action thiếu target bao xa? (diagnostic, không xếp hạng)
5. `solver`, `domainStatus`, `constraintsEnforced`: preferences đã được áp chưa?
6. `maxRegret` khi có `regretScope: pool`: so được giữa mọi action; hoặc `centralScore` nếu fallback.
7. `costUsd`, features, continuity và cache evidence: vì sao các action khác nhau?
8. `served`, provider failure và fallback rank: model nào thực sự phục vụ?

Xem thêm [Routing](routing.md) và [Glossary](glossary.md).
