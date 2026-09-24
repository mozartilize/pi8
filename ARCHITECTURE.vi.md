# Kiến trúc — pi8

Tài liệu mô tả kiến trúc triển khai của bộ định tuyến. Hướng dẫn cài đặt và các lệnh dành cho người dùng nằm trong [`README.md`](README.md); quy ước đóng góp nằm trong [`AGENTS.md`](AGENTS.md).

## Thuật ngữ và các mức tối thiểu

- **Loại công việc (`Dimension`)**: `lightweight`, `gather`, `plan`, `implement` hoặc `review`. **Bậc năng lực (`tier`)**: 0 (đủ điều kiện theo chất lượng đã đo), 1 (chưa biết chất lượng), 2 (đã đo nhưng chưa đạt yêu cầu). **Nhóm năng lực (`band`)**: `economy`, `standard`, `strong`, `frontier`, dùng cho bước cuối của công việc nhiều bước. Đây là ba thang đo khác nhau; nâng loại công việc không đồng nghĩa với nâng bậc năng lực.
- **Bước cuối (`terminal` trong code)**: kết quả cần có sau khi điều tra, thường là sửa file. `terminal` của stream lại là sự kiện kết thúc một lần thử model. **Giai đoạn điều tra (`inspect`)** diễn ra trước khi sửa. Mức ưu đãi có giới hạn cho phép dùng model thấp hơn yêu cầu của bước cuối một band cho đến khi bắt đầu sửa.
- **Economic promotion**: cho phép model tier-2 rẻ hơn tham gia khi chất lượng *đã đo* đạt tối thiểu 70% cho loại công việc và thỏa các điều kiện khác ở §2. Chất lượng ước lượng không đủ điều kiện.
- **Trajectory friction (TFI)**: dấu hiệu khách quan cho thấy lần thử bị kẹt, như lặp lại thao tác hoặc kiểm tra liên tục thất bại; không đánh giá ý nghĩa câu trả lời. **Provider circuit/strike**: bộ đếm lỗi của provider; ba strike tạm loại provider. Giới hạn sử dụng chung sẽ loại provider ngay.
- **Session generation/currentness**: generation đổi khi reset session; kết quả bất đồng bộ phải kiểm tra generation trước khi ghi trạng thái. **Assessment egress**: phần ngữ cảnh công việc giới hạn gửi đến provider đánh giá riêng. **Provenance** cho biết văn bản đến từ người dùng, trợ lý hay bản tóm tắt; **output ontology** là tập giá trị được phép trong kết quả đánh giá có cấu trúc.
- **Sidecar**: file nhật ký quyết định cạnh transcript của Pi. **Seam**: điểm thay thế path, timeout hoặc runtime dependency dành cho test.

Mỗi *mức tối thiểu* giới hạn một thứ khác nhau: **loại công việc tối thiểu theo heuristic** ngăn assessment thiếu chắc chắn hạ kết quả phân loại keyword; **loại công việc tối thiểu theo role** giới hạn lựa chọn subagent; **năng lực tối thiểu của model đang phục vụ** đòi hỏi chất lượng trên trục công việc được định tuyến ít nhất bằng chất lượng của model thực sự phục vụ trước đó, còn **mức suy luận tối thiểu của model này** giới hạn effort riêng. **Thinking tối thiểu theo loại công việc** đặt mức suy luận cho mỗi loại. **Năng lực tối thiểu của assessor** giới hạn model được dùng để đánh giá. Với chất lượng model, **mức task cho tier 0** mặc định là 85% so với peer mạnh nhất, **mức economic promotion** là 70%, và **mức broad-capability** là 45% cho implement/review. Công việc nhiều bước dùng **mức năng lực tối thiểu của bước cuối** theo band; **mức năng lực tối thiểu của giai đoạn điều tra** thấp hơn một band khi được ưu đãi. **Mức chất lượng triển khai tối thiểu của executor** trong execution contract là giá trị lớn hơn giữa mức yêu cầu tính từ rubric của submitter cộng số đo của router (ít nhất 30%) và mức tối thiểu của band (`economy` 30%, `standard` 45%, `strong` 70%). Hãy nói rõ thứ bị giới hạn thay vì chỉ viết “floor”.

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

### Bộ phân loại từ khóa (dự phòng, cho kết quả xác định)

Một classifier intent/keyword cục bộ, tốc độ cao, được port từ `complexity_router.py` của LiteLLM (Apache-2.0). Nó ánh xạ request sang một task dimension bằng năm danh sách keyword (`code`, `reasoning`, `technical`, `simple`, `gather`) cùng các marker riêng theo dimension (`review`, `plan`, các động từ thể hiện intent). Cơ chế chấm điểm tổng có trọng số dùng các dimension weight của LiteLLM để tạo confidence score; trường hợp hòa điểm được phân xử theo độ mạnh của dimension. Intent đã xác định được cache theo key của user entry và được tái sử dụng xuyên suốt vòng lặp tool của Pi cho entry đó, trừ khi có execution contract đang hoạt động (§7).

Với lời chấp thuận hoặc câu tiếp nối ngắn (ví dụ `ok go for it` hoặc `what's next?`), bộ phân loại dùng tối đa 1.500 ký tự ngữ cảnh người dùng/trợ lý có gắn nhãn vai trò, kết thúc tại entry đó. Các entry này dùng khóa khác để một lượt phân loại đầy đủ và phần tiếp nối ngắn chia sẻ cùng loại công việc.

Phạm vi ngữ nghĩa của bộ phân loại từ khóa được giữ ổn định: nó chỉ là phương án dự phòng bền vững, không phải bộ máy quyết định chính sách. Vẫn có thể điều chỉnh các ngưỡng cấu trúc (số token kích hoạt tăng mức theo độ sâu ngữ cảnh, thời hạn đánh giá, giới hạn đầu vào), nhưng không điều chỉnh danh sách từ khóa và quy tắc phạm vi.

### Đánh giá ngữ nghĩa (bật mặc định)

Bộ định tuyến gửi một yêu cầu đánh giá có giới hạn tới model đáp ứng mức năng lực tối thiểu `assessorQualityRatio` (mặc định bằng 0,5 lần năng lực suy luận của model mạnh nhất có thể định tuyến). Model đánh giá chỉ xác định loại công việc; bộ chấm điểm tất định vẫn quyết định model phục vụ.

Mỗi entry thực của người dùng chỉ được đánh giá một lần, với thời hạn tổng `assessmentDeadlineMs` (mặc định 1.500 ms). Đầu vào bị giới hạn bởi `assessmentMaxInputChars` (mặc định 6.000 ký tự), cắt phần cũ nhất trước và lọc thông tin xác thực trước khi gửi.

Kết quả đánh giá chỉ được áp dụng trong các giới hạn sau:

- Khi không chắc chắn, luôn route lên: assessment confidence thấp sẽ cho kết quả `max(heuristic, oneTierAbove(verdict))`, không bao giờ thấp hơn heuristic.
- Ở đầu entry, chỉ verdict **độ tin cậy cao, `scope: bounded`** mới được phép hạ loại công việc, tối đa **một bậc** (hoặc bỏ phần nâng do keyword không rõ ràng để trở về `rawHeuristic`), không bao giờ hạ từ `implement` hoặc `review`, và không bao giờ khi depth latch đang hoạt động.
- Giữa một intent, `plan`/`review` chỉ chuyển thành `implement` khi execution contract được chấp nhận (§7, cause `execution-contract`). Verdict `plan`/`review` với độ tin cậy cao khiến router từ chối contract; không có verdict thì không bị từ chối vì lý do đó. Chỉ phát hiện lệnh sửa file không làm đổi loại công việc; trạng thái hiển thị `editing` riêng.
- Khi chọn lại model theo trajectory, một lần consult đã nâng loại công việc vẫn giữ quyền quyết định đó (cause `router-consult` còn hiệu lực cho lần chọn lại).

Mỗi lần đánh giá ghi một bản ghi `assessment-metric` vào nhật ký quyết định, liên kết bằng `intentKey` để lưu mức thay đổi so với heuristic hoặc lý do dự phòng. Nếu depth latch chuyển trạng thái, router ghi thêm bản ghi thứ hai từ chính lần đánh giá đó, không gửi thêm yêu cầu. Chi phí đánh giá được theo dõi riêng với chi phí phục vụ.

Đặt `consultRouter: false` để định tuyến hoàn toàn cục bộ, không gửi yêu cầu đánh giá.

---

## 2. Chấm điểm (`scorer.ts`)

### Mở rộng candidate

Router tạo các ứng viên theo từng cặp `(model, effort)` được hỗ trợ. Một model trong registry có thể tạo nhiều ứng viên nếu dữ liệu benchmark đo nhiều mức effort, mỗi ứng viên có số liệu riêng về chất lượng, chi phí và tốc độ. Với mức được hỗ trợ nhưng chưa được đo, router ước lượng chất lượng bằng cách giảm dần từ mức đã đo gần nhất ở phía trên, rồi đánh dấu `qualityEstimated` (xem «Ước lượng effort»). Hàng `off` vẫn được đưa vào với model không có chế độ suy luận (đó là chế độ duy nhất model có thể phục vụ). Nếu `thinkingLevelMap` không hỗ trợ mức effort nào đã đo, model chỉ tạo một ứng viên không gắn mức effort.

### Ước lượng effort

Nguồn dữ liệu chỉ công bố các mức effort đã đo. Vì vậy, một mức dùng được (ví dụ `sonnet-5:medium`) có thể không có hàng dữ liệu dù `high` và `max` có. Router ước lượng mức này từ mức đã đo gần nhất **ở phía trên**, rồi trừ mức giảm chất lượng theo từng nấc. Chỉ ước lượng theo chiều giảm; không tạo ra mức chất lượng cao hơn hàng đã đo cao nhất.

Sau mỗi lần đồng bộ, mức giảm theo nấc được tính riêng cho từng trục chất lượng từ phân vị 90 (p90) của các mức giảm giữa hai nấc liền kề trong kho dữ liệu, thay vì dùng hằng số. Nếu dùng trung vị, giá trị ước lượng sẽ cao hơn giá trị thực khoảng một nửa số lần; dùng p90 giúp giá trị ước lượng thấp hơn giá trị thực khoảng 90% số lần. Mức thận trọng này cho phép ứng viên có chất lượng ước lượng tham gia lựa chọn. Trục có quá ít quan sát sẽ không được ước lượng từ dữ liệu nhiễu.

Ứng viên ước lượng có giá và cửa sổ ngữ cảnh (thuộc tính registry dùng chung giữa các mức effort), nhưng không có `costPerTask`, tốc độ hay độ trễ: đó là số đo theo lần chạy của một mức cụ thể. Chất lượng ước lượng có thể vượt qua mức năng lực tối thiểu thông thường, nhưng **economic promotion đòi hỏi số đo thực tế**: cơ chế này nới mức tối thiểu vì lợi thế giá; nếu dùng thêm năng lực suy đoán thì sẽ chồng hai giả định lên nhau.

### Các bậc năng lực

Model được phân loại vào ba tier dựa trên capability tương đối so với peer mạnh nhất trong phạm vi request hiện tại:

| Tier | Tiêu chí |
|---|---|
| 0 | Tỷ lệ trên task axis ≥ frontier ratio (85%), và nếu là `implement`/`review`: tỷ lệ broad-capability ≥ sanity floor (45%) |
| 1 | Chất lượng chưa biết (xếp sau tier-0 đã biết nhưng trước tier-2 yếu) |
| 2 | Dưới ngưỡng (yếu trên task axis hoặc không đạt sanity floor) |

Mọi tier đều vẫn nằm trong fallback chain: capability judgement kiểm soát model được ưu tiên, không bao giờ loại bỏ khả năng phục hồi trước lỗi khách quan.

### Ánh xạ loại công việc sang trục chất lượng

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

Cơ sở chi phí theo mỗi lần gọi: dùng `costPerTask` khi mọi candidate trong nhóm tier-0 trước khi xét economic promotion đều có số liệu (nếu không có candidate nào đạt tier 0 thì xét toàn bộ nhóm đã lọc). Nếu không, dùng giá pha trộn `$/1M` token (input×0,25 + output×0,75). Chỉ xét nhóm thực sự có thể thắng để một candidate chất lượng thấp thiếu `costPerTask` không buộc cả nhóm dùng thước đo thô hơn. Điều này quan trọng vì các mức effort của cùng model có giá `$/1M` như nhau và chỉ phân biệt được bằng `costPerTask`. Giá trong registry là nguồn có thẩm quyền khi tồn tại; giá benchmark là dự phòng. Model miễn phí có dữ liệu benchmark được coi là miễn phí thật; model miễn phí không có dữ liệu benchmark thì chưa rõ chi phí (không được ưu đãi chi phí).

### Ưu tiên giữ cache của model hiện tại

Nếu cặp `(model, effort)` thực sự phục vụ còn trong nhóm ứng viên có thể định tuyến, router lấy cặp đó làm incumbent; nếu không, router dùng lựa chọn được chấm điểm gần nhất. Mức năng lực tối thiểu của incumbent chọn ứng viên đầu tiên trong chuỗi có chất lượng đã biết trên trục công việc ít nhất bằng incumbent, chứ không bắt buộc giữ nguyên model. Nếu incumbent không còn trong chuỗi đã chấm điểm (ví dụ vì cửa sổ ngữ cảnh không đủ), mức tối thiểu không đưa nó trở lại. Incumbent được cộng điểm để giữ cache theo giá của chính model đó trong registry, không phải một hệ số cố định: `perTokenLoss = cacheWrite (hoặc input, nếu không có cacheWrite) − cacheRead`, giá trị đô-la của một token cache còn ấm. Khớp đúng incumbent được credit `min(estContextTokens × perTokenLoss, switchMargin)` — toàn bộ cuộc hội thoại. Đổi effort trên cùng model chỉ được credit `min(staticPrefixTokens × perTokenLoss, switchMargin)`, vì đổi effort làm invalidate message blocks nhưng cache của system/tool prefix vẫn ấm; candidate cùng model không có effort đo được (call shape mặc định của model) nhận full credit như khớp đúng incumbent. Đổi sang model khác nhận credit 0 — đổi model không có cache entry nào để giữ. Khi registry entry của incumbent không công bố đủ giá để tính `perTokenLoss` (thiếu `cacheRead`, và thiếu cả `cacheWrite`/`input`), không có retention credit nào được cấp. Bonus bị giới hạn bởi `switchMargin` (mặc định 0,15). Chỉ áp dụng khi caller cung cấp incumbent và không đặt `isSubagentSpawn`; role injection không cung cấp cả hai, vì vậy subagent spawn không bao giờ nhận bonus này (không có cache để mất).

### Mức suy luận tối thiểu

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

### Manual pin theo session

`/router-manual [provider/model[:thinking]|resume]` vẫn giữ `router/auto` là model đang hoạt động của Pi và chỉ lưu pin trong `RouterSession`; `reset()` sẽ xóa pin. Manual turn bỏ qua assessment dispatch, giới hạn việc chấm điểm vào các candidate của model đã pin, ghi cause `manual-override`, và rút fallback chain xuống effort variant được chọn. Vì vậy delegation chỉ có một model trong chain: failure được báo ra thay vì thay bằng model khác (chính sách retry cùng model thông thường vẫn áp dụng).

Thay đổi thinking level mà router không tự ghi (Shift+Tab, settings, hoặc `pi.setThinkingLevel` của extension khác) cũng gài pin: model đã serve lần gọi trước, ở level mới đã clamp theo mức model đó hỗ trợ. Pin đang có thì chuyển sang level mới. `thinking_level_select` của Pi không có source và cũng bắn ra khi router tự đồng bộ footer hoặc khi đổi model, nên router phát hiện thay đổi ở lần gọi provider kế tiếp: so `options.reasoning` với level Pi giữ ngay sau lần đồng bộ gần nhất của router (`syncedThinkingLevel`). Chuyển sang `router/auto` xoá mốc này. Khi chưa có model nào serve, thay đổi vẫn chỉ là effort override cho một turn.

`/router-manual resume` rời manual mode và tái sử dụng route trước khi pin. Lần pin đầu tiên chụp lại auto decision đang có hiệu lực (`resumeSnapshot`); `resume` kích hoạt snapshot đó và xóa pending trajectory escalation thu thập dưới pin để automatic routing không hành động theo evidence cũ. Router turn kế tiếp serve thẳng chosen model và fallback chain của snapshot — không classify, assessment hay scoring — dưới cause `resume`, đã lọc theo các entry trong chain còn routable (nếu rỗng thì rơi về routing thông thường). One-shot này giới hạn trong đúng một user entry qua `resumeIntentKey`: các tool-loop continuation cùng entry tái dùng nó, entry kế tiếp làm hết hiệu lực và tính lại. Khi không có pin (hoặc snapshot đã kích hoạt), `resume` là no-op.

Argument completer của command cung cấp danh sách model có thể tìm kiếm kiểu `/model ` sau khi nhấn Space. Command không có argument tái sử dụng `ModelSelectorComponent` do Pi export (UI search/navigation native của `/model`). Vì pin là override tường minh, danh sách phản ánh chính xác `/model` của Pi — model theo session scope khi session bị scope, ngược lại là mọi model đã xác thực trong registry — và cố tình **không** áp dụng allowlist, config/session blacklist, usage-limit hay scoped filter của router; chỉ loại provider tổng hợp `router/*`. Khi serve một pin nằm ngoài candidate pool của router, pin được expand ngay từ registry (bỏ qua các filter routing lúc build); blacklist do lỗi phát sinh trong session cũng không loại pin: nếu lỗi lặp lại, router báo lỗi của provider, đúng với quy tắc chỉ thử model đã pin và không thay thế nó. Không ghi gì vào `settings.json` hoặc config.

Khi `semi: true`, pick đã chấm điểm khác với model vừa serve sẽ chờ `ctx.ui.select` trước khi delegate: Yes dùng model mới, No giữ incumbent cho đúng user entry này (cause `semi-hold`; tool-loop continuation cùng entry tái dùng), và `provider/model-id[:thinking]` cụ thể gài pin session như `/router-manual`. Fallback sau lần thử thất bại hỏi lại. Dismiss/abort hủy turn thay vì chuyển. Session không interactive bỏ qua cổng này. `/router-semi [on|off]` ghi cờ này.

### Các lỗi trước khi có câu trả lời

| Lỗi | Cách xử lý |
|---|---|
| Không có trong registry | Đưa vào blacklist, chuyển candidate tiếp theo |
| Không có credential / auth timeout (5 giây) | Đưa vào blacklist, ghi một provider strike |
| First event timeout (30 giây) mà chưa có text/thinking/tool | Chuyển candidate tiếp theo |
| Provider trả `stopReason: error` | Retry cùng candidate (tối đa 2 lần với lỗi transient / 1 lần với lỗi generic), sau đó chuyển candidate tiếp theo |
| `done` bình thường nhưng không có text/thinking/tool output | Chuyển candidate tiếp theo |
| Tương tự, khi đang trả lời kết quả tool | Cho cùng candidate thử thêm một lần với một user turn do router thêm vào request: «Continue the task from the tool results above.» Nếu vẫn không trả lời thì chuyển candidate tiếp theo. Provider có agent loop riêng (ví dụ Claude Code bridge) chỉ nhận kết quả tool do chính nó gọi, nhưng có thể tiếp tục vòng tool của model khác khi nhận user turn mới kèm toàn bộ lịch sử. Turn thêm vào chỉ tồn tại trong request được ủy quyền, không ghi vào transcript của Pi; lần từ chối này không bị blacklist hay tính là provider strike. |
| Chỉ suy luận rồi hết giới hạn (`stopReason: length`, không có text/tool hiển thị) | Chuyển candidate tiếp theo |
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

Các role của pi-subagents (`researcher`, `planner`, `worker`, `reviewer`, `advisor`) cung cấp dimension tối thiểu qua `ROLE_DIMENSIONS`. Router xây và lọc auth snapshot candidate khi refresh session, sau đó chấm điểm lại từng structured child nhìn thấy lúc spawn theo role và task. `assessTerminal(task)` chỉ được nâng floor của role, không được hạ; dimension weights đã cấu hình và context guard đang hoạt động được áp dụng trước khi chèn `provider/model` qua hook `tool_call`. Child bên trong workflow script là opaque với structured walker, nên call đó vẫn dùng default cấp tool theo thứ tự worker-first (worker → planner → researcher → advisor → reviewer) thay vì định tuyến task-aware từng child. `model` riêng của từng child trong script vẫn được ưu tiên, và lỗi của child trong script vẫn là tool error thông thường. Child reviewer luôn được giữ khác model family với worker đã chọn.

Không ghi gì vào `settings.json` — việc chèn chỉ áp dụng cho từng spawn. Lựa chọn model tường minh và các pin của người dùng/project (`source` ≠ `pi8`) luôn được ưu tiên. Một child cụ thể không thể đổi model giữa chừng.

### Loại trừ theo usage-limit

Một foreground child thất bại với lỗi usage-limit của provider (quota/billing/subscription cap, khớp bởi `isUsageLimitErrorMessage` — cùng classifier mà main stream dùng) sẽ loại toàn bộ provider đó khỏi session, nên spawn sau và main turn đều bỏ qua mọi model trên nó (rule 8: cap được chia sẻ cho cả provider). Lỗi theo từng attempt gán cap cho đúng model. Đây là failure duy nhất của child được giữ lại: lỗi transient được pi-subagents/model retry, và lỗi đặc thù theo request (invalid request, refusal) không nói gì về sức khỏe provider. Router không bao giờ retry hay respawn child — việc khôi phục là quyết định của parent.

### Bộ lọc auth theo provider

Trước khi gán role cho subagent, một credential probe theo provider (timeout 3 giây) sẽ lọc các provider chưa xác thực. Nếu không có bước này, một lần subagent spawn kiểu pick-once trỏ đến provider chưa xác thực sẽ hard-fail. Nếu toàn bộ probe thất bại, trạng thái authentication được xem là chưa biết, không phải đã xác thực thành công — khi đó không thực hiện injection.

---

## 5. Depth escalation

Cơ chế này bao phủ một chuyển tiếp mà classifier không nhìn thấy: một gather session liên tục tích lũy context đã trở thành quá trình tổng hợp trên material đã thu thập, loại công việc mà các tier rẻ xử lý kém.

- **Trigger**: live context vượt `depthEscalationTokens` (mặc định 32768), pre-depth dimension là `lightweight`/`gather`, và cause thuộc nhóm depth-passive (`heuristic`, `continuation-context`, `no-data`, hoặc `router-consult`)
- **Effect**: nâng loại công việc một bước cho invocation đó (cause: `context-depth`)
- **Thuộc tính**: chỉ nâng lên, không bao giờ cache, đánh giá theo từng invocation
- **Ngoại lệ một lần**: chỉ lần nâng này đầu tiên trong mỗi session mới có thể bị hủy khi assessment có confidence cao và `scope: bounded`. Loại công việc và cause giữ nguyên; router dùng lại kết quả đánh giá của entry này, không gửi yêu cầu thứ hai. Nếu assessment timeout, không có hoặc bị tắt, hay trả về kết quả không hợp lệ, việc nâng vẫn diễn ra.

---

## 6. Các cơ chế escalation (2 đường riêng biệt)

### 1. Objective trajectory escalation

Các dấu hiệu tắc nghẽn khách quan (lặp thao tác/kết quả quan sát, kiểm tra liên tục thất bại, xác nhận không có tiến triển, vòng lặp suy luận trước khi có output) yêu cầu chọn lại model cùng loại công việc và ưu tiên chất lượng ở lần gọi provider kế tiếp, hoặc chuyển ngay nếu việc phát lại vẫn an toàn. Model không tự yêu cầu nâng cấp; `commit_execution` bàn giao việc cho executor, còn router quyết định executor (§7).

### 2. Automatic fallback trên main stream

Vòng lặp ủy quyền chỉ phản ứng với lỗi khách quan trước khi có câu trả lời. Không suy luận chất lượng ngữ nghĩa, không phát lại sau khi đã có nội dung hiển thị, một tool call, hoặc một lần xác nhận tràn giới hạn suy luận.

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

Mỗi intent sở hữu một `WorkPhase`: `answer` (lightweight), `inspect` (gather, hoặc phase mở đầu của một compound implementation đã engage), `reason` (plan/review), `mutate` (implement, hoặc một compound implementation sau khi đã rời `inspect`). Multi-work chỉ *engage* — cấp discount cho inspect phase — khi terminal kind là implement compound-eligible, band là `strong` hoặc `frontier`, confidence không thấp, và resolved dimension là `implement`. Sau khi engage, phase tiến `inspect` → `mutate` khi một routing owner mạnh hơn tiếp quản (resolved dimension đổi khỏi `implement`) — không bao giờ tự động lùi lại, và không bao giờ một khi turn đã rời `inspect`.

### Scoring policy (`scorer.ts`)

Một intent đã engage cung cấp một `MultiWorkScoringPolicy` request-local — `terminalFloor` (floor của terminal band) và `inspectFloor` (thấp hơn một band, khi còn ở `inspect`) — thay vì tham số tier/promotion sống thông thường. Đây là *nơi duy nhất* chất lượng được phép thấp hơn mức ưu tiên của bước cuối: một ngoại lệ về chi phí có giới hạn và xác định được cho giai đoạn điều tra, không phải hạ mức vì thiếu chắc chắn. Mỗi candidate được chấm điểm cũng mang `CandidateCapabilityMeta` (`taskRatio`, `clearsTerminalFloor`, `viaInspectPromotion`) để caller biết, theo từng candidate, liệu nó thực sự đạt terminal floor hay chỉ đạt inspect floor.

### Materialize served capability (`delegation.ts`)

Capability được đánh giá cho *candidate thực sự phục vụ* turn, không phải candidate xếp hạng cao nhất — fallback có thể phục vụ một sibling yếu hơn. `ServedCapabilityMeta` (provider invocation, terminal floor, liệu có candidate nào trong scoring set từng đạt floor, và capability của candidate đang phục vụ) được materialize trước khi decision state được publish, để mutation gate luôn đọc bằng chứng đã settle cho invocation đang thực sự stream.

### Mutation gate (`mutation-gate.ts`)

Các state transition thuần, fail-open, giới hạn theo invocation, gate các tool call `edit`/`write`. Khi đã engage và còn ở `inspect`, một mutation call bị block đúng một lần mỗi provider invocation trừ khi served capability đã đạt terminal floor (`clearsTerminalFloor === true`) hoặc thực sự unknown (`'unknown'` được cho qua — chưa đo không phải bằng chứng thiếu năng lực, và block trên đó sẽ chờ vô thời hạn). Một invocation sau đó, sau khi bị block, luôn thoát gate — một handoff giới hạn, không phải veto cứng, vì router không thể đảm bảo tồn tại một model mạnh hơn. Bằng chứng served-capability thiếu hoặc không nhất quán sẽ fail-open ngay thay vì làm nghẽn turn. Một call bị block trả về như một tool result lỗi, khiến agent yêu cầu một provider turn khác (theo hợp đồng tool-call/tool-result của Pi).

### Cam kết thực thi (`execution-contract.ts`, `execution-contract-tool.ts`)

Đây là cơ chế bàn giao tường minh từ `plan`/`review` sang `implement`. Model đang phục vụ gọi `commit_execution` để nộp kế hoạch khép kín cho phần việc còn lại: bước `edit`/`create` ghi đường dẫn và nội dung thay đổi cụ thể; bước `delete` ghi đường dẫn; bước `verify` xác định phép kiểm tra (`test`/`typecheck`/`lint`/`build`). Kế hoạch có tối đa 12 bước và không nhận đường dẫn dạng glob. Công cụ được đăng ký một lần và luôn sẵn dùng: nếu thay đổi danh sách công cụ giữa phiên, nhiều API của nhà cung cấp phải dựng lại phần đầu prompt và mất cache. Router từ chối mà không đổi trạng thái nếu phiên không dùng `router/auto`, quyết định hiện tại không thuộc `plan`/`review`, hoặc kết quả đánh giá có độ tin cậy cao cho biết người dùng chỉ yêu cầu lập kế hoạch hay rà soát. Vì chỉ dẫn ở đầu prompt dễ bị bỏ sót khi ngữ cảnh dài, router nối một lời nhắc cân nhắc gọi công cụ vào kết quả của lệnh `edit`/`write` tích hợp đầu tiên trong entry chưa có kế hoạch, nếu vẫn thỏa các điều kiện trên. Nối vào kết quả công cụ giữ nguyên phần đầu lịch sử hội thoại và cache của prompt. Mỗi lời nhắc được ghi thành bản ghi `nudge`; các entry có `nudge` nhưng không có `accept` cho biết một cơ hội bàn giao đã bị bỏ lỡ.

Router tự định giá kế hoạch thay vì để model quyết định (`execution-difficulty.ts`). Submitter chỉ mô tả phần việc còn lại: `remainingWork` chấm năm tiêu chí từ 1 (dễ nhất) đến 5 (khó nhất) — quyết định còn để ngỏ, độ dàn trải, cách kiểm chứng, lượng code cần hiểu ngoài các file liệt kê, và mức ảnh hưởng lan ra ngoài. Hỏi model công việc có dễ không thì nó thường trả lời rất tự tin bất kể đúng sai; còn mô tả theo thang cố định, do router gán trọng số, thì đối chiếu được với kết quả thật và hiệu chỉnh lại được. Mức yêu cầu bằng 30% cộng một bảng tra theo số quyết định còn để ngỏ (riêng mức 5 đã đạt 90%, nên submitter tự làm), tối đa 8 điểm cho mỗi tiêu chí còn lại, và tối đa 4 điểm cho mỗi số đo: số file, số thư mục, số dòng hiện có của các file cần sửa/xóa, và số commit sửa lỗi chạm vào các file đó trong 180 ngày gần nhất (`git log`). Tiêu chí không được chấm tính như mức 5; số đo thất bại tính ở mức giữa, nên không cái nào làm mức yêu cầu thấp đi. Số commit, số file test và số bước chỉ được ghi log, không có trọng số. Mức yêu cầu quy ra band (`economy` < 45%, `standard` < 70%, `strong` < 85%, cao hơn thì submitter tự làm). Hình dạng kế hoạch chỉ được nâng band: hơn 2 file hoặc 4 bước cần ít nhất `standard`; hơn 5 file hoặc 8 bước thì submitter tự làm, và file cần sửa/xóa không tồn tại cũng vậy. Mỗi model thực thi đã bị loại trong cùng công việc đẩy band lên một bậc. Khi band cho phép bàn giao, các lần gọi tiếp theo được định tuyến như `implement`: mức chất lượng triển khai tối thiểu của executor thay cho tỷ lệ tier-0 85%, còn hai mức tối thiểu về năng lực và suy luận của incumbent được bỏ để bộ chấm điểm có thể chọn model rẻ hơn. Nếu kế hoạch giữ việc ở model nộp, loại công việc vẫn chuyển thành `implement`, nhưng cả hai mức tối thiểu của incumbent được giữ nguyên. Trọng số hiện đặt tay; mỗi contract ghi log rubric, số đo và kết quả để sau này thay bằng trọng số học từ dữ liệu.

Cam kết được coi là đã thực thi (`executed`) khi lệnh `edit`/`write` tích hợp đã thành công trên mọi file `edit`/`create` khai báo, hoặc khi model thực thi đã dùng hết `2 × số bước + 4` lượt gọi provider (router không quy được lệnh sửa bằng Bash hay thao tác xóa file cho file nào, nên giới hạn này là cách kết thúc những kế hoạch như vậy). Executor là model đầu tiên khác submitter phục vụ một lượt gọi của kế hoạch đã bàn giao. Kế hoạch đã bàn giao vẫn có thể chỉ do submitter phục vụ: submitter có thể thắng khi chấm điểm, hoặc được dùng làm fallback. Kế hoạch do model khác thực thi được định tuyến như `review` đến hết entry, với submitter là incumbent và loại công việc của submitter làm mức suy luận tối thiểu: một kế hoạch làm xong vẫn có thể sai theo cách mà không vi phạm nào phát hiện được, và chỉ submitter mới đánh giá được kết quả theo đúng ý định ban đầu. Chuyển ngay ở lượt gọi sau lần sửa file khai báo cuối cùng là điểm duy nhất router bảo đảm được: một khi model trả lời chỉ bằng text, vòng lặp của Pi kết thúc và không còn lượt gọi nào để chuyển về. Vì vậy, các bước `verify` sau lần sửa file khai báo cuối cùng được chạy trong lúc review. Kế hoạch chỉ do submitter phục vụ thì tiếp tục như `implement`. Kết quả của lần chạy verifier đầu tiên sau khi thực thi được ghi là `pass`/`fail`. Một lần gọi `commit_execution` mới trong lúc review được coi là **làm lại** (rework): nó tính một strike cho model thực thi, giống như vi phạm, và kế hoạch sửa đổi giữ nguyên loại công việc ban đầu. Cam kết kết thúc cùng entry — khi lượt chạy của Pi đã dừng hẳn, hoặc khi một entry đang xếp hàng bắt đầu — và được gắn nhãn `clean` (không sửa gì lúc review), `fixed` (submitter đã sửa), `rework`, `broken` hoặc `unfinished` (vẫn đang chạy); router ghi một bản ghi `outcome`.

Cam kết bị phá khi model thực thi sửa file ngoài danh sách đã khai báo bằng `edit`/`write` tích hợp, gọi lại `commit_execution`, hoặc kích hoạt chuyển giao do tắc nghẽn trong quá trình làm việc. Router không chặn lệnh gây vi phạm; thao tác đọc file, chạy lệnh và sửa file bằng Bash không được quy cho một đường dẫn đích. Ở lần gọi provider kế tiếp, router trở lại loại công việc của model nộp kế hoạch, lấy model đó làm incumbent và áp dụng mức suy luận tối thiểu tương ứng với loại công việc ấy; một lần chuyển giao trajectory đang chờ vẫn được ưu tiên. Cam kết được xóa để model nộp kế hoạch có thể nộp bản sửa đổi. Mỗi model thực thi có tối đa hai strike (vi phạm hoặc làm lại) trong cùng công việc; sau lần thứ hai, model đó bị loại ở mọi mức effort và trên mọi provider. Các model thực thi tiếp theo còn phải có chất lượng triển khai **đã đo** lớn hơn model bị loại mạnh nhất. Vì vậy, sau tối đa ba lần loại, việc bàn giao dừng lại ở model nộp kế hoạch. Số lần vi phạm và danh sách loại trừ được giữ qua các lời nhắn tiếp nối ngắn; cam kết đang hoạt động thì không.

### Assessor v2 contract (`assessment-prompt.ts`)

`ASSESSMENT_PROMPT_VERSION = '2.0.0'`. Assessor trả về shape `{ kind, complexity, scope, compound, confidence, reasoning }` như terminal classifier (`ParsedAssessment`/`RoutingAssessment`). Verdict hợp lệ được áp dụng theo các giới hạn ở §1 và ghi thành record `assessment-metric`. Verdict `kind` là `plan`/`review` với độ tin cậy cao khiến router từ chối execution contract; `complexity`/`compound` không quyết định việc chấp nhận kế hoạch. Bộ phân loại terminal tất định riêng xác định band cho multi-work. Không tự hạ mức định tuyến ở giai đoạn kiểm tra.

### Hiển thị decision

`RoutingDecision.multiWork` (một `MultiWorkRoutingMeta`) chỉ có mặt cho các intent đã engage. `/router-status` và `/router-why` (`formatDecisionDetail` trong `ui.ts`) in terminal kind/complexity/band và phase/invocation, tỉ lệ served capability thực tế (hoặc `unknown` khi không có ratio đo được), và một dòng gate chỉ khi thực sự có block/escape xảy ra. Quyết định không có metadata multi-work vẫn có thể hiển thị `editing` sau khi phát hiện lệnh sửa file; loại công việc chỉ đổi khi execution contract được chấp nhận. `/router-why` hiển thị trạng thái contract ở dòng `plan:` — band và mức tối thiểu của executor, lý do submitter tự làm, ai đã thực thi, hoặc lý do bị phá — và dòng `excluded:` khi một model executor đã bị loại.

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

Sidecar dạng append-only theo từng session, nằm cạnh transcript của Pi (`<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl`; các session tạm thời không có persisted session file dùng chung `~/.pi/agent/pi8/decisions.jsonl`): loại công việc, model được chọn, cause, fallback chain, chẩn đoán capability gate, assessment verdict, record `assessment-metric` và record `execution-contract` (accept/reject/break/nudge/execute/outcome, kèm band, mức tối thiểu của executor, điểm rubric, các số đo, nhãn kết quả, mã lý do từ chối và khóa model; không ghi đường dẫn hoặc nội dung thay đổi của kế hoạch). Các giá trị cause: `heuristic`, `continuation-context`, `router-consult`, `execution-contract`, `embedding-classify`, `error-fallback`, `no-data`, `capability-escalation`, `trajectory-escalation`, `context-depth`, `self-healing-gap`, `manual-override`, `resume`, `semi-hold`.

### Timing log

Timing từng bước theo mili-giây (opt-in qua config `debug`): chờ registry, phân loại, auth/stream attempt theo từng candidate, tổng thời gian mỗi lượt. Được ghi dưới dạng sidecar `*.router-debug.log` theo từng session (`/tmp/pi8-debug.log` khi là session tạm thời).

---

## 9. Tham chiếu cấu hình

Các tùy chọn trong `~/.pi/agent/pi8/config.json`:

| Key | Mặc định | Mô tả |
|---|---|---|
| `artificialAnalysisApiKey` | — | Được lưu bởi `/router-sync` |
| `models` | `[]` (tất cả) | Allowlist: glob pattern `provider/id` (wildcard `*`, không phân biệt hoa thường; tên provider trần nghĩa là `provider/*`) |
| `blacklist` | `[]` | Các exclude pattern được lưu bền vững, cú pháp giống `models` |
| `consultRouter` | `true` | Công tắc tổng cho semantic assessment; `false` thì không gửi assessment request nào |
| `consultModel` | — | Model assessor override, tùy chọn |
| `assessmentDeadlineMs` | `1500` | Ngân sách end-to-end cho assessor |
| `assessmentMaxInputChars` | `6000` | Giới hạn input của assessor |
| `assessorQualityRatio` | `0.5` | Competence floor của assessor |
| `depthEscalation` | `true` | Tự động nâng khi context sâu |
| `depthEscalationTokens` | `32768` | Ngưỡng context token |
| `prompt` | `true` | Thông báo TUI khi đổi model |
| `semi` | `false` | Hỏi trước khi chuyển khỏi model vừa serve |
| `switchMargin` | `0.15` | Giới hạn cache-preservation cho incumbent; `0` tắt bonus |
| `routerContextWindow` | Cửa sổ của model đã phục vụ | Cửa sổ ngữ cảnh mà `router/auto` công bố. Pi dựa vào đó để quyết định khi nào rút gọn hội thoại: sau khi một model đã phục vụ, router công bố cửa sổ và giới hạn output của model đó; trước lần phục vụ đầu tiên, router công bố cửa sổ lớn nhất trong các model có thể định tuyến. Đặt giá trị thấp hơn để Pi rút gọn sớm hơn, giữ các model có cửa sổ nhỏ đủ điều kiện lâu hơn. Giá trị vượt mặc định sẽ bị giới hạn về mặc định. |
| `debug` | `false` | Đường dẫn timing log hoặc `true` |
| `syntheticPrefixes` | `[]` | Các literal prefix đánh dấu synthetic message |
| `dimensionWeights` | mặc định theo từng dimension | Override `{quality, cost, speed}` cho từng dimension |
| `lowConfidenceThreshold` | `0.15` | Ngưỡng classifier confidence mà dưới đó áp dụng uncertainty handling |
| `sources` | — | Lựa chọn nguồn benchmark |
| `consultRouterAgent` | — | Alias đầu vào cũ; dùng `consultRouter` (chính tắc) cho config mới |
| `embeddingClassifier` | `false` | Classifier E5-small local cho prompt không có bằng chứng keyword; chỉ nâng lên; cần các package tùy chọn `onnxruntime-node` và `@xenova/transformers` |
| `embeddingDeadlineMs` | `5000` | Ngân sách cho load model + inference; hết hạn thì giữ kết quả keyword |
| `embeddingMinConfidence` | `0.15` | Margin tối thiểu giữa hai prototype score cao nhất để verdict embedding được áp dụng |

---

## 10. Ngoài phạm vi

- Chấm chất lượng câu trả lời theo ngữ nghĩa hoặc tự động retry dựa trên chất lượng cảm nhận
- Replay sau khi đã có text hiển thị hoặc tool call, hoặc thay thế child đang chạy ngay tại chỗ
- Định tuyến dựa trên kết quả đã ghi nhớ: kết quả của execution contract chỉ được ghi log để hiệu chỉnh trọng số độ khó ngoại tuyến; lúc chạy, chỉ strike do làm lại trong cùng một công việc dùng đến chúng
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
