# ARCHITECTURE.md — pi8

Kiến trúc ở cấp độ triển khai của router. Để xem hướng dẫn thiết lập và lệnh dành cho người dùng, hãy xem [`README.md`](README.md). Để xem quy ước dành cho người đóng góp, hãy xem [`AGENTS.md`](AGENTS.md).

## Tổng quan pipeline

```
/router-sync (chạy theo yêu cầu, cảnh báo khi dữ liệu đã cũ hơn 14 ngày)
   └─ adapter: artificial-analysis  (REST, API key miễn phí)
         chuẩn hóa + fuzzy-match với registry model đang hoạt động của Pi
~/.pi/agent/pi8/benchmarks.json
        ▼
phân loại + đánh giá (cho mỗi entry của người dùng) → một trong 5 dimension
        ▼
pickBest(candidates × measured effort, dimension, weights) → chuỗi fallback đã xếp hạng
        ▼
ủy quyền cho candidate (model, effort) đứng đầu; nếu có lỗi khách quan trước khi trả lời, chuyển tiếp dọc theo chuỗi
```

Ở mỗi lượt:

1. **Xác định intent** — hai classifier chạy cho mỗi entry thực của người dùng.
2. **Chấm điểm** — mở rộng các candidate `(model, effort)`, lọc theo capability, xếp hạng theo chất lượng/chi phí/tốc độ.
3. **Ủy quyền với fallback khách quan** — stream, xử lý lỗi trước khi có câu trả lời, rồi đi dọc theo chuỗi.
4. **Định tuyến subagent** — chèn model cụ thể cho mỗi lần spawn thông qua hook `tool_call`.

---

## 1. Xác định intent

### Keyword classifier (fallback tất định)

Một classifier intent/keyword cục bộ, tốc độ cao, được port từ `complexity_router.py` của LiteLLM (Apache-2.0). Nó ánh xạ request sang một task dimension bằng năm danh sách keyword (`code`, `reasoning`, `technical`, `simple`, `gather`) cùng các marker riêng theo dimension (`review`, `plan`, các động từ thể hiện intent). Cơ chế chấm điểm tổng có trọng số dùng các dimension weight của LiteLLM để tạo confidence score; trường hợp hòa điểm được phân xử theo độ mạnh của dimension. Intent đã xác định được cache theo key của user entry và được tái sử dụng xuyên suốt vòng lặp tool của Pi cho entry đó.

Các câu chấp thuận hoặc chuyển tiếp ngắn (ví dụ `ok go for it` hoặc `what's next?`) sử dụng tối đa 1.500 ký tự context user/assistant có gắn nhãn role và kết thúc tại entry đó; chúng được đánh key khác để một lượt phân loại đầy đủ và phần tiếp nối ngắn của nó dùng chung intent dimension.

Phạm vi ngữ nghĩa của keyword classifier được đóng băng — nó tồn tại như một fallback có khả năng sống sót, không phải policy engine. Các threshold mang tính cấu trúc (token để depth escalation, deadline đánh giá, giới hạn input) vẫn có thể điều chỉnh; danh sách keyword và quy tắc phạm vi thì không.

### Semantic assessment (bật mặc định)

Assessment luôn bật sẽ dispatch một model call có giới hạn — được chọn từ routable pool dưới một competence floor (`assessorQualityRatio`, mặc định bằng 0,5 lần mức intelligence mạnh nhất có thể định tuyến) — và chỉ hỏi loại công việc đang được yêu cầu. Deterministic scorer vẫn là thành phần quyết định model nào thực sự phục vụ.

Mỗi user entry thực chỉ có một assessment, bị giới hạn bởi một end-to-end deadline duy nhất (`assessmentDeadlineMs`, mặc định 1500 ms). Input bị giới hạn bởi `assessmentMaxInputChars` (mặc định 6000), cắt từ phần cũ nhất trước, và được loại bỏ credential trước khi dispatch.

Verdict được áp dụng dưới các giới hạn nghiêm ngặt:

- Khi không chắc chắn, luôn route lên: assessment confidence thấp sẽ cho kết quả `max(heuristic, oneTierAbove(verdict))`, không bao giờ thấp hơn heuristic.
- Chỉ verdict **confidence cao, `scope: bounded`** mới được phép hạ dimension, tối đa **một tier** (hoặc giải phóng bump nhập nhằng từ keyword về `rawHeuristic`), không bao giờ hạ từ `implement` hoặc `review`, và không bao giờ khi depth latch đang hoạt động.
- Capability repick: consult đã nâng dimension sẽ sở hữu quyết định đó (`router-consult` vẫn là cause đang hoạt động cho mục đích capability repick).

Mỗi lần assessment ghi một record `assessment-metric` vào decision log, join bằng `intentKey`, để giữ lại heuristic delta hoặc fallback reason. Một depth-latch transition ghi metric thứ hai từ cùng một assessment dispatch duy nhất. Chi phí assessment được theo dõi riêng với chi phí routing.

Đặt `consultRouter: false` để routing hoàn toàn cục bộ và không dispatch assessment.

---

## 2. Chấm điểm (`scorer.ts`)

### Mở rộng candidate

Candidate được mở rộng theo từng cặp `(model, effort)` đã được đo và được hỗ trợ. Một model trong registry có thể tạo ra nhiều routable candidate khi benchmark có các row ở nhiều effort level khác nhau — mỗi candidate có measurement riêng về chất lượng/chi phí/tốc độ. Effort level không có measurement sẽ không bao giờ được tổng hợp giả định (không đo nghĩa là chất lượng chưa biết). Các row `off` vẫn được phát ra ngay cả với model không reasoning (đó là mode duy nhất có thể phục vụ của chúng). Khi toàn bộ effort đã đo không được `thinkingLevelMap` của model hỗ trợ, model fallback về một candidate duy nhất không có effort.

### Các capability tier

Model được phân loại vào ba tier dựa trên capability tương đối so với peer mạnh nhất trong phạm vi request hiện tại:

| Tier | Tiêu chí |
|---|---|
| 0 | Tỷ lệ trên task axis ≥ frontier ratio (85%), và nếu là `implement`/`review`: tỷ lệ broad-capability ≥ sanity floor (45%) |
| 1 | Chất lượng chưa biết (xếp sau tier-0 đã biết nhưng trước tier-2 yếu) |
| 2 | Dưới ngưỡng (yếu trên task axis hoặc không đạt sanity floor) |

Mọi tier đều vẫn nằm trong fallback chain: capability judgement kiểm soát model được ưu tiên, không bao giờ loại bỏ khả năng phục hồi trước lỗi khách quan.

### Ánh xạ dimension sang axis

| Dimension | Task axis (cổng eligibility) | Quality axis (xếp hạng) |
|---|---|---|
| `lightweight` | intelligence (không áp dụng floor) | intelligence |
| `gather` | intelligence | intelligence |
| `plan` | intelligence (không bao giờ được promote) | intelligence |
| `implement` | agenticCoding → coding (fallback) | agenticCoding → coding (fallback) |
| `review` | coding → intelligence (chỉ cho xếp hạng) | coding → intelligence |

`implement` dùng agentic-coding làm axis chính (`artificial_analysis_agentic_index` của AA), fallback sang coding khi không có. Ranking axis có fallback để mọi model đều được sắp xếp dựa trên dữ liệu thực; eligibility axis thì không (yêu cầu bằng chứng trực tiếp).

### Economic promotion (có giới hạn)

Một candidate tier-2 chỉ có thể được nâng lên tier 0 khi đáp ứng **tất cả** các điều kiện sau:

1. Tỷ lệ trên task axis ≥ economy floor (70%)
2. Đạt sanity floor (nếu là `implement`/`review`)
3. Giá ≤ model tier-0 rẻ nhất ÷ 4 (lợi thế gấp bốn)
4. Không bị Pareto-dominate bởi peer rẻ hơn và có capability tương đương
5. Không phải sibling: provider khác của cùng một benchmark row không được tính là peer

Promotion chỉ được đánh giá cho `gather`, `implement` và `review`. `plan` không bao giờ được promote và `lightweight` hoàn toàn không bị gate.

### Tín hiệu chi phí

Cơ sở chi phí theo mỗi call: dùng `costPerTask` khi mọi candidate đều có; nếu không thì dùng giá pha trộn `$/1M` token (input×0,25 + output×0,75). Giá trong registry là nguồn có thẩm quyền khi tồn tại; giá benchmark là fallback. Model miễn phí có benchmark data được xem là dữ liệu thực (zero-cost là chủ ý); model miễn phí không có benchmark data được xem là chưa biết (không được hưởng cost credit).

### Switch penalty

Model đang phục vụ nhận cache-preservation bonus được định giá từ kinh tế học registry của chính incumbent, không phải một mức flat unitless: `perTokenLoss = cacheWrite (hoặc input, nếu không có cacheWrite) − cacheRead`, giá trị đô-la của một token cache còn ấm. Khớp đúng incumbent được credit `min(estContextTokens × perTokenLoss, switchMargin)` — toàn bộ cuộc hội thoại. Đổi effort trên cùng model chỉ được credit `min(staticPrefixTokens × perTokenLoss, switchMargin)`, vì đổi effort làm invalidate message blocks nhưng cache của system/tool prefix vẫn ấm; candidate cùng model không có effort đo được (call shape mặc định của model) nhận full credit như khớp đúng incumbent. Đổi sang model khác nhận credit 0 — đổi model không có cache entry nào để giữ. Khi registry entry của incumbent không công bố đủ giá để tính `perTokenLoss` (thiếu `cacheRead`, và thiếu cả `cacheWrite`/`input`), không có retention credit nào được cấp. Bonus bị giới hạn bởi `switchMargin` (mặc định 0,15). Chỉ áp dụng khi caller cung cấp incumbent và không đặt `isSubagentSpawn`; role injection không cung cấp cả hai, vì vậy subagent spawn không bao giờ nhận bonus này (không có cache để mất).

### Effort floor

Reasoning effort tối thiểu cho từng dimension — đây là **floor**, không phải assignment. Effort đã đo có thể nâng lên, không bao giờ hạ xuống:

| Dimension | Thinking tối thiểu |
|---|---|
| `lightweight` | off |
| `gather` | low |
| `implement` | medium |
| `review` | high |
| `plan` | max |

Effort do router chọn sử dụng **up-only walk** (`levelFrom`) từ floor đã clamp — một khoảng trống trong `thinkingLevelMap` không bao giờ được resolve xuống dưới floor. Yêu cầu reasoning tường minh từ người dùng sử dụng nearest-first walk để tôn trọng lựa chọn của người dùng sát nhất có thể.

---

## 3. Vòng lặp delegation fallback (`delegation.ts`)

Vòng lặp đi dọc fallback chain đã xếp hạng (mỗi entry là key `provider/id:effort`) và stream candidate đầu tiên tạo ra output có ý nghĩa.

Tính khả dụng của provider chỉ được xác định tại thời điểm stream. Registry auth-filtering là theo provider, không phải theo model, và per-attempt credential check mới là cổng kiểm tra thực sự — một provider đã xác thực vẫn có thể trả 421, treo hoặc lỗi trên một model cụ thể. Fallback chain sẽ hấp thụ lỗi đó, nhưng latency của lần thử đầu tiên đã bị tiêu tốn.

### Các lỗi trước khi có câu trả lời

| Lỗi | Cách xử lý |
|---|---|
| Không có trong registry | Đưa vào blacklist, chuyển candidate tiếp theo |
| Không có credential / auth timeout (5 giây) | Đưa vào blacklist, ghi một provider strike |
| First event timeout (30 giây) mà chưa có text/thinking/tool | Chuyển candidate tiếp theo |
| Provider trả `stopReason: error` | Retry cùng candidate (tối đa 2 lần với lỗi transient / 1 lần với lỗi generic), sau đó chuyển candidate tiếp theo |
| `done` sạch nhưng không có text/thinking/tool output | Chuyển candidate tiếp theo |
| Hết reasoning-only (`stopReason: length`, không có text/tool hiển thị) | Chuyển candidate tiếp theo |
| Người dùng abort | Kết thúc, không blacklist |

### Provider circuit breaker

Ba provider-health strike (credential, auth, transport, `stopReason: error`) sẽ bỏ qua các model còn lại của provider đó. Lỗi hết output limit theo từng model và lỗi không có trong registry không làm cả provider bị đánh giá xấu — sibling model cùng provider vẫn có thể được dùng.

Lỗi usage-limit — hết quota/billing, OpenCode `GoUsageLimitError`, hoặc plain 429/rate-limit — sẽ blacklist toàn bộ provider cho session ngay lập tức, bỏ qua cơ chế tích lũy ba strike: giới hạn được chia sẻ cho mọi model trên provider đó, vì vậy retry sibling chỉ làm lãng phí thời gian. Lỗi hết output limit riêng theo model không bao giờ kích hoạt cơ chế này. `/router-blacklist remove <provider>/*` sẽ gỡ exclusion sau khi top-up.

### Resolve effort cho từng chain entry

Mỗi chain entry mang effort riêng từ benchmark row. Effort do router chọn được clamp theo dimension floor và resolve bằng up-only walk (`levelFrom`). Yêu cầu reasoning tường minh từ người dùng dùng nearest-first walk (`resolveThinkingLevel`) để tôn trọng lựa chọn của người dùng sát nhất với khả năng model hỗ trợ.

### Tính không thể đảo ngược sau khi có nội dung

Khi text hiển thị hoặc tool call đã được stream, router không bao giờ replay trên model khác — việc đó sẽ tạo output hoặc side effect trùng lặp. Lỗi xảy ra sau đó sẽ được báo vào stream.

---

## 4. Định tuyến subagent

### Chèn role

Các role của pi-subagents (`researcher`, `planner`, `worker`, `reviewer`, `advisor`) cung cấp dimension tối thiểu qua `ROLE_DIMENSIONS`. Router xây và lọc auth snapshot candidate khi refresh session, sau đó chấm điểm lại từng structured child nhìn thấy lúc spawn theo role và task. `assessTerminal(task)` chỉ được nâng floor của role, không được hạ; dimension weights đã cấu hình và context guard đang hoạt động được áp dụng trước khi chèn `provider/model` qua hook `tool_call`. Child bên trong workflow script là opaque với structured walker, nên call đó vẫn dùng default cấp tool theo thứ tự worker-first thay vì định tuyến task-aware từng child.

Không ghi gì vào `settings.json` — việc chèn chỉ áp dụng cho từng spawn. Lựa chọn model tường minh và các pin của người dùng/project (`source` ≠ `pi8`) luôn được ưu tiên. Một child cụ thể không thể đổi model giữa chừng.

### Loại trừ theo usage-limit

Một foreground child thất bại với lỗi usage-limit của provider (quota/billing/subscription cap, khớp bởi `isUsageLimitErrorMessage` — cùng classifier mà main stream dùng) sẽ loại toàn bộ provider đó khỏi session, nên spawn sau và main turn đều bỏ qua mọi model trên nó (rule 8: cap được chia sẻ cho cả provider). Lỗi theo từng attempt gán cap cho đúng model. Đây là failure duy nhất của child được giữ lại: lỗi transient được pi-subagents/model retry, và lỗi đặc thù theo request (invalid request, refusal) không nói gì về sức khỏe provider. Router không bao giờ retry hay respawn child — việc khôi phục là quyết định của parent.

### Bộ lọc auth theo provider

Trước khi gán role cho subagent, một credential probe theo provider (timeout 3 giây) sẽ lọc các provider chưa xác thực. Nếu không có bước này, một lần subagent spawn kiểu pick-once trỏ đến provider chưa xác thực sẽ hard-fail. Nếu toàn bộ probe thất bại, trạng thái authentication được xem là chưa biết, không phải đã xác thực thành công — khi đó không thực hiện injection.

---

## 5. Depth escalation

Cơ chế này bao phủ một chuyển tiếp mà classifier không nhìn thấy: một gather session liên tục tích lũy context đã trở thành quá trình tổng hợp trên material đã thu thập, loại công việc mà các tier rẻ xử lý kém.

- **Trigger**: live context vượt `depthEscalationTokens` (mặc định 32768), lượt được phân loại là `lightweight`/`gather`, không có active routing intent (escalation/user override)
- **Effect**: nâng một tier cho invocation đó (cause: `context-depth`)
- **Thuộc tính**: chỉ nâng lên, không bao giờ cache, đánh giá theo từng invocation
- **Latch veto**: lần chuyển depth-latch đầu tiên trong mỗi session có thể bị veto bởi assessment confidence cao, `scope: bounded`. Veto nghĩa là từ chối escalation — dimension và cause giữ nguyên — và tái sử dụng assessment verdict hiện có của entry thay vì dispatch assessment thứ hai. Mọi failure path (timeout, không có assessor, reply không parse được, assessment bị tắt) đều escalation mà không có veto.

---

## 6. Các cơ chế escalation (2 đường riêng biệt)

### 1. Capability escalation trong hội thoại chính

Tự chạy `/router-escalate [dimension]`. Không có argument sẽ nâng một tier; dimension tường minh yếu hơn dimension được route gần nhất sẽ bị từ chối. Ở cùng dimension, capability repick ưu tiên chất lượng sẽ loại model đang yêu cầu. Model không tự escalate. Trajectory friction khách quan (lặp action/observation, failure dai dẳng, stagnation đã xác nhận, reasoning loop trước output) đặt pending same-dimension quality-first repick cho provider invocation kế tiếp, hoặc hop ngay khi replay vẫn an toàn.

### 2. Automatic fallback trên main stream

Delegation loop chỉ phản ứng với lỗi khách quan trước khi có câu trả lời. Không suy luận chất lượng ngữ nghĩa, không replay sau khi đã có output hiển thị.

---

## 7. Terminal work và multi-work routing

Bao phủ các yêu cầu implement dạng compound tường minh — "tìm X, rồi sửa nó" — nơi deliverable cuối (một mutation) khó hơn chính inspect phase của nó. Các intent thông thường không bị ảnh hưởng: cơ chế này chỉ engage cho các turn dimension `implement` có terminal classification là compound và discount-eligible.

### Terminal classification (`terminal-classifier.ts`)

Một classifier cấu trúc thuần, deterministic — tách biệt với các classifier dimension theo keyword/semantic — trích một `TerminalAssessment` cho mỗi entry: `kind` (cùng từ vựng với `Dimension`), `complexity` (`trivial`|`routine`|`moderate`|`hard`|`frontier`), `scope` (`bounded`|`open-ended`), `compound`, `confidence`, và `discountEligible`. `compound` đòi hỏi cấu trúc tường minh prerequisite → sequence → mutation (vd. "điều tra race condition, rồi sửa nó"); bất kỳ giá trị nào bị suy ra mặc định (complexity hoặc scope không match trực tiếp) sẽ giữ lại `discountEligible = false` — discount của inspect phase là một giấy phép, nên chỉ bằng chứng rõ ràng mới được cấp.

### Terminal requirement và capability band (`work-phase.ts`)

```
requirement = clamp01(KIND_BASE[kind] + 0.5 × COMPLEXITY[complexity] + (scope === 'open-ended' ? 0.1 : 0))
```

| Band | Requirement | Floor |
|---|---|---|
| `economy` | < 0.30 | none |
| `standard` | < 0.50 | 0.45 |
| `strong` | < 0.75 | 0.70 |
| `frontier` | ≥ 0.75 | 0.85 |

### Vòng đời phase

Mỗi intent sở hữu một `WorkPhase`: `answer` (lightweight), `inspect` (gather, hoặc phase mở đầu của một compound implementation đã engage), `reason` (plan/review), `mutate` (implement, hoặc một compound implementation sau khi đã rời `inspect`). Multi-work chỉ *engage* — cấp discount cho inspect phase — khi terminal kind là implement compound-eligible, band là `strong` hoặc `frontier`, confidence không thấp, resolved dimension là `implement`, và không có capability repick đang active. Sau khi engage, phase tiến `inspect` → `mutate` khi một routing owner mạnh hơn tiếp quản (dimension đổi khỏi `implement`, hoặc một capability repick kích hoạt) — không bao giờ tự động lùi lại, và không bao giờ một khi turn đã rời `inspect`.

### Scoring policy (`scorer.ts`)

Một intent đã engage cung cấp một `MultiWorkScoringPolicy` request-local — `terminalFloor` (floor của terminal band) và `inspectFloor` (thấp hơn một band, khi còn ở `inspect`) — thay vì tham số tier/promotion sống thông thường. Đây là *nơi duy nhất* chất lượng có thể được đo dưới terminal preference: một economic promotion bị giới hạn, deterministic cho inspect phase, không phải một hạ cấp vì uncertainty. Mỗi candidate được chấm điểm cũng mang `CandidateCapabilityMeta` (`taskRatio`, `clearsTerminalFloor`, `viaInspectPromotion`) để caller biết, theo từng candidate, liệu nó thực sự đạt terminal floor hay chỉ đạt inspect floor.

### Materialize served capability (`delegation.ts`)

Capability được đánh giá cho *candidate thực sự phục vụ* turn, không phải candidate xếp hạng cao nhất — fallback có thể phục vụ một sibling yếu hơn. `ServedCapabilityMeta` (provider invocation, terminal floor, liệu có candidate nào trong scoring set từng đạt floor, và capability của candidate đang phục vụ) được materialize trước khi decision state được publish, để mutation gate luôn đọc bằng chứng đã settle cho invocation đang thực sự stream.

### Mutation gate (`mutation-gate.ts`)

Các state transition thuần, fail-open, giới hạn theo invocation, gate các tool call `edit`/`write`. Khi đã engage và còn ở `inspect`, một mutation call bị block đúng một lần mỗi provider invocation trừ khi served capability đã đạt terminal floor (`clearsTerminalFloor === true`) hoặc thực sự unknown (`'unknown'` được cho qua — chưa đo không phải bằng chứng thiếu năng lực, và block trên đó sẽ chờ vô thời hạn). Một invocation sau đó, sau khi bị block, luôn thoát gate — một handoff giới hạn, không phải veto cứng, vì router không thể đảm bảo tồn tại một model mạnh hơn. Bằng chứng served-capability thiếu hoặc không nhất quán sẽ fail-open ngay thay vì làm nghẽn turn. Một call bị block trả về như một tool result lỗi, khiến agent yêu cầu một provider turn khác (theo hợp đồng tool-call/tool-result của Pi).

### Assessor v2 contract (`assessment-prompt.ts`)

`ASSESSMENT_PROMPT_VERSION = '2.0.0'`. Assessor trả về shape `{ kind, complexity, scope, compound, confidence, reasoning }` như terminal classifier (`ParsedAssessment`/`RoutingAssessment`). Verdict thành công được áp dụng theo các giới hạn trong §1 và ghi thành record `assessment-metric`. Các field `complexity`/`compound` của assessor chỉ cung cấp thông tin cho terminal classification — chúng không bao giờ gate routing trực tiếp, và không có down-routing tự động cho verify-phase.

### Hiển thị decision

`RoutingDecision.multiWork` (một `MultiWorkRoutingMeta`) chỉ có mặt cho các intent đã engage. `/router-status` và `/router-why` (`formatDecisionDetail` trong `ui.ts`) in terminal kind/complexity/band và phase/invocation, tỉ lệ served capability thực tế (hoặc `unknown` khi không có ratio đo được), và một dòng gate chỉ khi thực sự có block/escape xảy ra. Các decision không có multiWork metadata đã engage vẫn render y hệt như trước.

---

## 8. Luồng dữ liệu

### Benchmark

**Artificial Analysis** Data API (free tier, header `x-api-key`) là nguồn benchmark duy nhất. Các row chứa `evaluations` (intelligence, coding, agentic indices), `pricing` ($/1M input/output) và `performance` (tokens/giây, TTFT, TTFA). Mức độ bao phủ chất lượng bị giới hạn bởi dữ liệu mà Artificial Analysis công bố: model không có row khớp sẽ không có quality signal và chỉ route dựa trên registry metadata.

**Effort label** được parse từ phần trong ngoặc của tên model: `GPT-5.6 Luna (low)`, `Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)`, `DeepSeek V4 Flash (Non-reasoning)` → `off`. Quá trình parse fail closed (không nhận diện được → undefined).

**Run variant**: AA chạy lại benchmark dưới các cấu hình khác nhau, thêm hậu tố `-<4 chữ số>` vào slug (ví dụ `gpt-5-6-luna-low-1234`). Các hậu tố này được loại bỏ bằng một variant list tường minh trong `matcher.ts`. Variant list được viết tường minh thay vì dùng quy tắc strip tổng quát vì việc strip hậu tố chung sẽ làm hỏng identity thật của model như `qwen3.7-max`.

**Định dạng store**: identity là `(registryId, effort)` — phân tách bằng NUL trong storage, dùng `provider/id:effort` trong candidate key. Store v2 sẽ loại bỏ store v1 và chỉ ghi một dòng cảnh báo. Các source được chọn được refresh như một transaction duy nhất — nếu một source bị outage một phần, store trước đó được giữ lại thay vì ghi đè bằng dataset không đầy đủ.

### Fuzzy matching

Benchmark slug được fuzzy-match với model ID trong live registry của Pi. Có thể dùng manual override qua `/router-fix` khi matching thất bại; cho đến khi có override, model chưa match sẽ không có quality data và chỉ route dựa trên registry metadata.

### Session state & lifecycle

Routing state được đóng gói thành các domain aggregate có thể khởi tạo độc lập:
- `RouterSession`: Container root sở hữu session generation, decision/model được serve gần nhất, candidate expansion cache, embedding tallies và các domain sub-object. Được clear khi `session_start` hoặc khi reset test.
- `BlacklistState`: Đóng gói các exclusion lúc runtime cho model và provider, cũng như các session glob pattern chuẩn hóa không phân biệt hoa thường.
- `AssessmentState`: Theo dõi chi phí assessor, EMA ước lượng usage input/output và strike count theo từng model.
- `IntentState`: Quản lý cached routing intent qua các vòng tool loop, depth-latch generation, latch veto intent key và compound work-phase state.
- `RuntimeBindings`: Lưu trữ `ExtensionContext` của Pi, `modelRegistry` hiện hành và signature đăng ký provider. Tồn tại qua các lần reset `session_start` và chỉ bị xóa khi extension shutdown hoặc reload.

### Decision log

Sidecar dạng append-only theo từng session, nằm cạnh transcript của Pi (`<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl`; các session tạm thời không có persisted session file dùng chung `~/.pi/agent/pi8/decisions.jsonl`): dimension, model được chọn, cause, fallback chain, chẩn đoán capability gate, assessment verdict và record `assessment-metric`. Các giá trị cause: `heuristic`, `continuation-context`, `user-escalation`, `router-consult`, `capability-escalation`, `trajectory-escalation`, `error-fallback`, `no-data`, `context-depth`, `self-healing-gap`.

### Timing log

Timing từng bước theo mili-giây (opt-in qua config `debug`): chờ registry, phân loại, auth/stream attempt theo từng candidate, tổng thời gian mỗi lượt. Được ghi dưới dạng sidecar `*.router-debug.log` theo từng session (`/tmp/pi8-debug.log` khi là session tạm thời).

---

## 9. Tham chiếu cấu hình

Các tùy chọn trong `~/.pi/agent/pi8/config.json`:

| Key | Mặc định | Mô tả |
|---|---|---|
| `artificialAnalysisApiKey` | — | Được lưu bởi `/router-sync` |
| `models` | `[]` (tất cả) | Allowlist: glob pattern `provider/id` |
| `blacklist` | `[]` | Các exclude pattern được lưu bền vững |
| `consultRouter` | `true` | Công tắc tổng cho semantic assessment |
| `consultModel` | — | Model assessor override, tùy chọn |
| `assessmentDeadlineMs` | `1500` | Ngân sách end-to-end cho assessor |
| `assessmentMaxInputChars` | `6000` | Giới hạn input của assessor |
| `assessorQualityRatio` | `0.5` | Competence floor của assessor |
| `depthEscalation` | `true` | Tự động nâng khi context sâu |
| `depthEscalationTokens` | `32768` | Ngưỡng context token |
| `prompt` | `true` | Thông báo TUI khi đổi model |
| `switchMargin` | `0.15` | Giới hạn cache-preservation cho incumbent |
| `debug` | `false` | Đường dẫn timing log hoặc `true` |
| `syntheticPrefixes` | `[]` | Các literal prefix đánh dấu synthetic message |
| `dimensionWeights` | mặc định theo từng dimension | Override `{quality, cost, speed}` cho từng dimension |
| `lowConfidenceThreshold` | `0.15` | Ngưỡng classifier confidence mà dưới đó áp dụng uncertainty handling |
| `sources` | — | Lựa chọn nguồn benchmark |
| `consultRouterAgent` | — | Alias đầu vào cũ; dùng `consultRouter` (chính tắc) cho config mới |

---

## 10. Ngoài phạm vi

- Chấm chất lượng câu trả lời theo ngữ nghĩa hoặc tự động retry dựa trên chất lượng cảm nhận
- Replay sau khi đã có text hiển thị hoặc tool call, hoặc thay thế child đang chạy ngay tại chỗ
- Vòng lặp phản hồi có xác minh bằng thực thi / ghi nhớ outcome
- Hoạt động như model gateway/proxy cho các tool không thuộc Pi

---

## 11. Phát triển

```bash
npm run check   # tsc --noEmit + vitest run
```

Các module cốt lõi:

- `scorer.ts` — scoring thuần, `pickBest`, capability tier, effort resolution (không I/O)
- `classifier.ts` — keyword classification thuần (không I/O)
- `consult.ts` — dispatch assessment: streaming model call, parse, timeout
- `delegation.ts` — fallback loop: auth, retry, circuit breaker, timeout
- `provider.ts` — orchestrator: chờ registry, classify/escalate/consult, score, delegate; đồng thời sở hữu `buildSubagentProviderAuthFilter`, credential probe 3 giây theo từng provider
- `index.ts` — hook wiring; chạy credential probe trước khi gán role
- `adapters/` — nguồn benchmark data (hiện chỉ có `artificial-analysis.ts`)
- `subagents.ts` — role injection (không tự thực hiện probe)
