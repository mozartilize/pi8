# Kiến trúc cốt lõi — pi8

Tài liệu này là đặc tả kỹ thuật chuyên sâu về 5 thành phần kiến trúc cốt lõi của bộ định tuyến `pi8`:
- **§1. Độ khó và nhu cầu năng lực (Difficulty & Task Demand)**
- **§2. Xây dựng candidate và 10 đặc trưng mong muốn (Candidate Building & Feature Extraction)**
- **§3. Bộ chọn tối ưu hóa thống nhất (Unified Optimization Selector — Minimax Regret)**
- **§4. Hợp đồng thực thi (Execution Contract)**
- **§5. Vòng lặp ủy quyền và phục hồi lỗi (Delegation & Fallback Loop)**

Các thông tin về hướng dẫn cài đặt và lệnh người dùng nằm trong [`README.md`](README.md); quy ước đóng góp nằm trong [`AGENTS.md`](AGENTS.md).

---

## 1. Độ khó và nhu cầu năng lực (Difficulty & Task Demand)

Mô-đun `task-demand.ts` và `difficulty.ts` đóng vai trò là chủ thể duy nhất (single owner) tổng hợp các khai báo đã được chấp thuận (giai đoạn công việc, rubric độ khó, các quyết định còn để ngỏ, cờ thu thập ngữ cảnh) cùng với các đặc trưng đo đạc trực tiếp từ mã nguồn và đầu vào (kích thước ngữ cảnh, hình ảnh). Các thành phần chấm điểm và trích xuất đặc trưng phía sau chỉ đọc kết quả từ `TaskDemand`, tuyệt đối không tự tính toán lại nhu cầu.

### 1.1. Phân định giai đoạn và trọng số liên quan (`TaskRelevance`)

Mỗi loại công việc (`Dimension`: `lightweight`, `gather`, `plan`, `implement`, `review`) có mức độ gắn kết nền tảng (`PHASE_RELEVANCE`) đối với 3 trục năng lực:

```typescript
export const PHASE_RELEVANCE: Readonly<Record<Dimension, TaskRelevance>> = {
  lightweight: { reasoning: 0.15, agentic: 0,    research: 0.1  },
  gather:      { reasoning: 0.40, agentic: 0,    research: 1.0  },
  plan:        { reasoning: 1.00, agentic: 0.25, research: 0.5  },
  implement:   { reasoning: 0.60, agentic: 1.00, research: 0.15 },
  review:      { reasoning: 1.00, agentic: 0.50, research: 0.8  },
};
```

- **Quyết định để ngỏ (`openDecisions`)**: Khi có ít nhất một quyết định thiết kế hoặc hành vi chưa chốt (`openDecisions > 0`), mức độ liên quan của trục suy luận tự động nâng lên tối thiểu là `OPEN_DECISIONS_REASONING = 0.9`:
  $$\text{relevance.reasoning} = \max(\text{base.reasoning}, 0.9)$$
- **Giai đoạn thu thập (`gather`)**: Khi cờ `contextAcquisition === true` (thu thập ngữ cảnh ban đầu), tác vụ chưa có nhu cầu chuyển giao cụ thể. Trục suy luận được cố định tại mục tiêu tiết kiệm `ACQUISITION_REASONING_TARGET = 0.20`, bảo đảm ưu tiên các model nhanh và kinh tế.

### 1.2. Chuẩn hóa rubric độ khó

Các rubric được khai báo từ model nộp kế hoạch hoặc bàn giao ngữ cảnh theo thang đo 1 (dễ nhất) đến 5 (khó nhất). Hàm `level(v)` chuẩn hóa các giá trị nguyên này về đoạn $[0, 1]$:
$$\text{level}(v) = \text{clamp01}\left(\frac{v - 1}{4}\right)$$
Nếu một tiêu chí không được điền hoặc không phải số hữu hạn, nó mặc định nhận giá trị 1.0 (mức độ khó tối đa), tuân thủ nguyên tắc an toàn thận trọng (fail-safe).

#### A. Rubric thực thi (`ExecutionRubric`)
Được cung cấp qua công cụ `commit_execution`, gồm 5 tiêu chí:
1. `openDecisions`: Quyết định kiến trúc, hành vi chưa chốt.
2. `spread`: Phạm vi dàn trải của thay đổi qua các file và module.
3. `verification`: Khả năng kiểm chứng bằng test hoặc typecheck tự động.
4. `knowledge`: Tri thức ngầm định ngoài các file đã chỉ định.
5. `coupling`: Mức độ phụ thuộc và tác động lan truyền sang hệ thống khác.

Công thức xác định nhu cầu các trục:
$$\begin{aligned}
\text{demand.reasoning} &= \max(\text{open}, \text{knowledge}, \text{coupling}) \\
\text{demand.agentic} &= \text{clamp01}\big(\max(\text{open}, \text{spread}, \text{verification}, \text{coupling}) + \text{measuredDemand}\big) \\
\text{demand.research} &= \max(\text{open}, \text{knowledge})
\end{aligned}$$

#### B. Rubric suy luận (`ReasoningRubric`)
Được cung cấp qua công cụ `hand_off_context`, gồm 5 tiêu chí:
1. `alternatives`: Số lượng phương án thiết kế khả thi cần cân nhắc.
2. `stakes`: Hậu quả nếu đưa ra quyết định sai lầm.
3. `spread`: Phạm vi ảnh hưởng của quyết định.
4. `knowledge`: Tri thức cần thiết ngoài bằng chứng hiện hữu.
5. `uncertainty`: Mức độ mù mờ về dữ kiện và yêu cầu.

Công thức xác định nhu cầu các trục:
$$\begin{aligned}
\text{demand.reasoning} &= \max(\text{alternatives}, \text{stakes}, \text{knowledge}, \text{uncertainty}) \\
\text{demand.agentic} &= \text{clamp01}\big(\max(\text{spread}, \text{stakes}, \text{uncertainty}) + \text{measuredDemand}\big) \\
\text{demand.research} &= \max(\text{knowledge}, \text{uncertainty})
\end{aligned}$$

*Nguyên tắc giá trị cực đại (Independent Maxima)*: Nhu cầu trên từng trục là giá trị lớn nhất giữa các tiêu chí độc lập. Một tiêu chí dễ không bao giờ được phép làm loãng một quyết định thiết kế phức tạp hay một rủi ro kiến trúc cao.

### 1.3. Đo lường mã nguồn bổ sung (`measuredDemand`)

Router đo lường 4 chỉ số khách quan từ repository tại thời điểm kiểm tra để bổ sung tối đa $+0.20$ vào nhu cầu lập trình (`agentic demand`), mỗi chỉ số đóng góp tối đa $+0.05$:

$$\text{measuredDemand} = 0.05 \times \left( f_{\text{files}} + f_{\text{dirs}} + f_{\text{lines}} + f_{\text{fixes}} \right)$$

1. **Số file tác động** ($f_{\text{files}}$): $\text{clamp01}\left(\frac{\text{files} - 1}{4}\right)$ — bão hòa khi $\ge 5$ file.
2. **Số thư mục tác động** ($f_{\text{dirs}}$): $\text{clamp01}\left(\frac{\text{directories} - 1}{3}\right)$ — bão hòa khi $\ge 4$ thư mục.
3. **Số dòng mã hiện hữu** ($f_{\text{lines}}$): $\text{clamp01}\left(\frac{\log_2(\max(\text{lines}, 1) / 250)}{4}\right)$ — đạt cực đại tại $250 \times 2^4 = 4.000$ dòng.
4. **Commit sửa lỗi gần đây trong 180 ngày** ($f_{\text{fixes}}$): $\text{clamp01}\left(\frac{\text{fixes}}{5}\right)$ — bão hòa khi $\ge 5$ commit từ `git log`.

Nếu phép đo nào thất bại hoặc thiếu dữ liệu, giá trị đóng góp của phép đo đó được tính bằng 1.0 (nhận đủ $+0.05$), ngăn chặn việc thiếu dữ kiện làm hạ thấp độ khó ước tính.

### 1.4. Khoảng nhu cầu thô khi thiếu rubric (`COMPLEXITY_DEMAND`)

Khi model không cung cấp rubric mà chỉ khai báo mức độ phức tạp (`ComplexityBand`), nhu cầu được định hình theo khoảng chính sách (policy bounds):

| Độ phức tạp | Cận dưới (`lower`) | Trung tâm (`center`) | Cận trên (`upper`) |
|---|---|---|---|
| `trivial` | $0.000$ | $0.000$ | $0.125$ |
| `routine` | $0.125$ | $0.250$ | $0.375$ |
| `moderate` | $0.375$ | $0.500$ | $0.625$ |
| `hard` | $0.625$ | $0.750$ | $0.875$ |
| `frontier` | $0.875$ | $1.000$ | $1.000$ |

- Nếu phạm vi tác vụ là `open-ended`, cận trên của trục lập trình tự động mở rộng lên $1.0$, vì không thể giới hạn khối lượng công việc khi chưa có kế hoạch cụ thể.
- Khi không có bất kỳ khai báo nào, nhu cầu là khoảng bất định toàn phần $[0, 1]$ với trung tâm là $0.5$.

### 1.5. Mục tiêu năng lực chuẩn hóa (`capabilityTarget`)

Nhu cầu $[0, 1]$ trên từng trục được ánh xạ sang thang điểm chuẩn hóa của benchmark thông qua phép nội suy tuyến tính giữa cận dưới (`easy`) và cận trên (`hard`):
$$\text{target} = \text{easy} + (\text{hard} - \text{easy}) \times \text{clamp01}(\text{difficulty})$$

Các khoảng mục tiêu tuyệt đối:
- **Trục suy luận (`reasoning`)**: $[0.20, 0.55]$ trên thang Intelligence Index (Artificial Analysis).
- **Trục lập trình (`agentic`)**: $[0.01, 0.60]$ trên thang Terminal-Bench 4.0 pass rate.
- **Trục nghiên cứu (`research`)**: $[0.25, 0.65]$ trên thang Briefcase / Omniscience rubric.

Hệ thống tính toán độ hụt năng lực (`shortfall`):
$$\text{shortfall} = \max(0, \text{target} - \text{quality})$$
Độ vừa vặn năng lực được chuẩn hóa theo thang đo hụt:
$$\text{fit} = \text{clamp01}\left(1 - \frac{\text{shortfall}}{\text{shortfallScale}}\right)$$
với $\text{shortfallScale} = 0.15$ cho suy luận, và $0.20$ cho lập trình và nghiên cứu. Model có năng lực vượt quá mục tiêu không nhận thêm điểm thưởng nhằm tránh lãng phí tài nguyên không cần thiết.

---

## 2. Xây dựng candidate và 10 đặc trưng mong muốn

Mô-đun `candidate.ts` là điểm duy nhất tạo dựng vector đặc trưng cho mỗi hành động có thể phục vụ (`EffectiveAction`). Mỗi hành động là một cặp xác định `(model, effort)` với khóa định danh dạng `provider/id[:effort]`.

### 2.1. Mở rộng ứng viên và ước lượng nấc suy luận (Effort Estimates)

1. **Khám phá mức effort**: Router đọc các mức suy luận model hỗ trợ qua `getSupportedThinkingLevels`. Nếu model hỗ trợ tắt suy luận, mức `off` được bổ sung vào danh sách.
2. **Ước lượng chiều giảm (Downward Effort Estimates)**: Dữ liệu benchmark thực tế thường chỉ đo một số mức effort cụ thể (ví dụ `high`, `max`). Nếu một mức effort được model hỗ trợ nhưng chưa được đo (ví dụ `medium`), router ước lượng chất lượng bằng cách lấy mức đã đo gần nhất ở phía trên trừ đi mức giảm p90 (`p90 stepdown delta`) tính toán từ toàn bộ cơ sở dữ liệu benchmark. Quá trình ước lượng chỉ đi xuống, không bao giờ ước lượng hướng lên vượt quá mức đo cao nhất.
3. **Kiểm tra cửa sổ ngữ cảnh**: Hàm `holdsPrompt` loại bỏ các model có `contextWindow < promptTokens \times 1.2`. Cửa sổ tối thiểu phải bao quát kích thước prompt thực tế cộng biên an toàn 20%.

### 2.2. Schema 10 đặc trưng (`feature-v11`)

Mọi đặc trưng $j \in \{0, \dots, 9\}$ đều được biểu diễn dưới dạng một khoảng bất định $[lower_j, upper_j]$ kèm giá trị trung tâm $center_j \in [lower_j, upper_j]$, chuẩn hóa trên đoạn $[0, 1]$ với quy ước: **giá trị càng lớn càng có lợi**.

#### Đặc trưng 1–3: Độ vừa vặn năng lực (`reasoningFit`, `agenticFit`, `researchFit`)
Tính từ công thức độ vừa vặn với mục tiêu ở §1. Khi model thiếu điểm benchmark trên trục tương ứng:
$$lower = 0, \quad center = 0.5, \quad upper = 1.0$$
Khoảng bất định mở rộng tối đa thể hiện sự thiếu hụt bằng chứng, không loại bỏ model khỏi cuộc cạnh tranh.

#### Đặc trưng 4: Độ phù hợp đầu vào (`inputFit`)
Đánh giá khả năng xử lý ngữ cảnh dài và dữ liệu đa phương thức (hình ảnh):
- **Ngữ cảnh dài (`longContext`)**: Khi kích thước prompt ước lượng $\ge \text{LONG\_CONTEXT\_RELEVANCE\_TOKENS} = 64.000$ tokens, đặc trưng đánh giá theo chỉ số LCR (Long-Context Retrieval/Reasoning) hoặc NIAH.
- **Thị giác (`vision`)**: Khi đầu vào chứa hình ảnh, đặc trưng đánh giá theo benchmark MMMU-Pro / Vision Reasoning.

#### Đặc trưng 5: Độ mong muốn chi phí kinh tế (`costDesirability`)
Chi phí proxy là tổng của chi phí prompt ở lượt hiện tại cộng chi phí sinh token dự kiến cho toàn bộ tác vụ theo benchmark:
$$\text{CostProxy} = \text{Cost}_{\text{prompt}} + \text{Cost}_{\text{benchmark\_output}}$$

1. **Phân tách token prompt**:
   - `cacheRead`: Token thuộc tiền tố cache còn ấm (`usableWarmPrefix`).
   - `cacheWrite`: Token ghi cache mới (chỉ tính phí khi provider có biểu giá ghi riêng).
   - `uncachedInput`: Token đầu vào thông thường.
   - Token prompt được nhân với hệ số trung bình trượt luỹ thừa `promptTokenScales` để phản ánh đúng khối lượng token thực tế sau khi pi-ai dựng payload.
2. **Chi phí output benchmark**: Lấy số token sinh ra trung bình cho mỗi tác vụ từ Artificial Analysis (`outputTokensPerTask`) nhân với đơn giá output trong registry.
3. **Ánh xạ hàm Logarit**:
   $$\text{costDesirability} = \text{clamp01}\left(1 - \frac{\log_{10}(\text{usd} / 0.00001)}{6}\right)$$
   Thang đo trải rộng qua 6 bậc độ lớn từ $\$0.00001$ đến $\$10.00$. Bất kỳ mức giá nào $\le \$0.00001$ đều đạt điểm tối đa 1.0. Nhờ tính chất logarit, tỷ lệ tiết kiệm tương đối giữa hai model (ví dụ rẻ hơn gấp đôi) tạo ra độ chênh lệch đặc trưng không đổi $\frac{\log_{10}(2)}{6} \approx 0.0502$ ở bất kỳ phân khúc giá nào.

#### Đặc trưng 6: Độ mong muốn thời gian thực thi (`timeDesirability`)
Thời gian thực thi proxy phản ánh độ trễ sinh kết quả cho toàn bộ tác vụ benchmark:
$$\text{seconds} = \frac{\text{tokensPerTask}}{\text{outputSpeedTps}}$$
Nếu mức effort cụ thể thiếu tốc độ token/giây, router lấy khoảng tốc độ từ các mức effort khác của cùng model (`speed-other-effort`).
Ánh xạ qua hàm logarit với tham số định hình 60 giây và bão hòa tại 3.600 giây (1 giờ):
$$\text{timeDesirability} = \text{clamp01}\left(1 - \frac{\ln(1 + \text{seconds} / 60)}{\ln(1 + 3600 / 60)}\right)$$
Tác vụ hoàn thành ngay lập tức đạt 1.0; tác vụ kéo dài từ 1 giờ trở lên nhận điểm 0.0.

#### Đặc trưng 7: Tính liên tục (`continuity`)
Duy trì sự ổn định của model đang phục vụ (`incumbent`), bảo tồn ngữ cảnh và phong cách lập luận:
- **Biên thông thường (`boundary: ordinary`)**:
  - Giữ nguyên model: $0.65$
  - Đổi sang model khác: $0.45$
- **Biên làm lại (`boundary: rework`)**:
  - Giữ cùng model nhưng tăng effort: $0.78$
  - Giữ cùng model với effort bằng hoặc thấp hơn: $0.65$
  - Đổi sang model khác: $0.48$
- Không có incumbent hoặc không rõ danh tính: $0.50$

#### Đặc trưng 8: Tránh ma sát quỹ đạo (`frictionAvoidance`)
Ngăn chặn việc chọn lại model/effort vừa gây ra sự cố trong cùng một công việc (`workItemId`):
- Gặp lỗi làm lại đã quy kết (`attributed-rework`): $0.00$
- Vướng vòng lặp suy luận nghiêm trọng (`severe-reasoning-loop`): $0.25$
- Không có ma sát: $1.00$

#### Đặc trưng 9–10: Phục hồi khi làm lại (`effortRecoveryFit`, `modelSwitchRecoveryFit`)
Chỉ kích hoạt tại ranh giới làm lại (`boundary === 'rework'`) sau khi kế hoạch bị trả về:
- `effortRecoveryFit`: Bằng $1.0$ nếu chọn cùng model với mức effort cao hơn mức đã thất bại; ngược lại bằng $0.0$.
- `modelSwitchRecoveryFit`: Bằng $1.0$ nếu chuyển hẳn sang một model khác; ngược lại bằng $0.0$.

---

## 3. Bộ chọn tối ưu hóa thống nhất (Unified Optimization Selector — Minimax Regret)

Mô-đun `minimax.ts`, `domain.ts`, và `compile.ts` thực hiện việc lựa chọn ứng viên tối ưu toán học. Không còn sự tồn tại của các nhóm lọc hard-filter hay các quy tắc gán cứng.

### 3.1. Định thức toán học Minimax Regret

Với hai hành động $a$ và $b$, mức hối tiếc từng cặp (Pairwise Regret — $PR(a, b)$) khi chọn $a$ thay vì $b$ trên miền trọng số $\Theta$ là sự chênh lệch hữu ích lớn nhất trong trường hợp xấu nhất:
$$PR(a, b) = \max_{\theta \in \Theta} \theta \cdot (\mathbf{upper}(b) - \mathbf{lower}(a)), \quad PR(a, a) = 0$$

Mức hối tiếc tối đa của hành động $a$ (Maximum Regret — $MR(a)$) trên toàn bộ tập đối thủ cạnh tranh:
$$MR(a) = \max_{b} \max\big(0, PR(a, b)\big)$$

Hành động được chọn là hành động cực tiểu hóa mức hối tiếc tối đa:
$$a^* = \arg\min_{a} MR(a)$$

Việc sử dụng $\mathbf{lower}(a)$ (kịch bản tồi nhất của $a$) và $\mathbf{upper}(b)$ (kịch bản tốt nhất của $b$) tạo ra một bao đóng an toàn bảo thủ (conservative envelope), phản ánh đầy đủ rủi ro do sự bất định của dữ liệu.

### 3.2. Thứ tự phân xử hòa điểm (Tie-Breaking Hierarchy)

Khi hai candidate có mức hối tiếc chênh lệch không vượt quá ngưỡng dung sai số học (`LP_RESIDUAL_TOLERANCE = 1e-6`), thứ tự ưu tiên được giải quyết tuần tự qua các tiêu chí:
1. **Tính liên tục phi tài chính (`continuity`)**: Giá trị trung tâm cao hơn xếp trước (dung sai $10^{-6}$).
2. **Độ tin cậy giá**: Giá đã biết xếp trước giá chưa biết.
3. **Chi phí kinh tế trung tâm (`centralUSD`)**: Chi phí thấp hơn xếp trước (dung sai $10^{-12}$).
4. **Khóa định danh (`canonical key`)**: So sánh chuỗi ký tự theo thứ tự từ điển (`a.id < b.id`).

### 3.3. Tối ưu hóa hiệu năng giải LP

Việc giải bài toán LP cho mọi cặp $(a, b)$ với tập candidate lớn đòi hỏi tối ưu hóa cấu trúc:

1. **Loại bỏ đối thủ bị thống trị (Dominator Pruning)**:
   Nếu tồn tại hành động $c \ne a$ có $\mathbf{upper}(c) \ge \mathbf{upper}(b)$ trên mọi chiều đặc trưng, thì $PR(a, b) \le PR(a, c)$ với mọi $\theta \ge 0$. Do đó, $b$ bị bỏ qua khỏi danh sách đối thủ cần giải LP của $a$.
2. **Cận trên dạng đóng (`baseDomainMax`)**:
   Trên miền cơ sở $\Theta_{\text{base}}$ với các cận độc lập và điều kiện $\sum \theta_j = 1$, giá trị cực đại của $\mathbf{c} \cdot \theta$ có nghiệm giải tích dạng đóng (tham lam gán trọng số cho hệ số lớn nhất). Vì miền hợp lệ $\Theta \subseteq \Theta_{\text{base}}$, giá trị này là chặn trên tuyệt đối của bài toán LP:
   - Các đối thủ được sắp xếp theo cận trên giảm dần.
   - Quá trình duyệt dừng ngay khi cận trên của đối thủ tiếp theo nhỏ hơn mức hối tiếc lớn nhất hiện tại của $a$ cộng dung sai.
3. **Giải hàng loạt theo khối (LP Chunking)**:
   Các bài toán LP được nhóm thành từng khối 16 mục tiêu (`LP_CHUNK = 16`) để tận dụng tính năng vector hóa của bộ giải HiGHS WebAssembly.

### 3.4. Biên dịch miền trọng số người dùng ($\Theta$)

Miền $\Theta$ bắt đầu từ miền cơ sở $\Theta_{\text{base}}$ (các cận biên kỹ thuật của từng đặc trưng thỏa mãn $\sum_{j=0}^{9} \theta_j = 1$) và được thu hẹp bởi hồ sơ sở thích người dùng `preferences` (phiên bản 1):

1. **Chế độ `base`**: Người dùng không trả lời hoặc bỏ qua tất cả câu hỏi. Miền chính là $\Theta_{\text{base}}$. Nghiệm giải quyết hoàn toàn bằng dạng đóng, 0 lần gọi LP.
2. **Chế độ `hard`**: Các câu trả lời của người dùng tạo thành các siêu phẳng ràng buộc tuyến tính:
   $$\theta \cdot \mathbf{\Delta}_k \ge \text{CHOICE\_MARGIN} = 0.04$$
   Nếu hệ ràng buộc này tương thích với $\Theta_{\text{base}}$, miền tối ưu hóa là đa diện giao giữa chúng.
3. **Chế độ `min-slack`**: Khi các câu trả lời của người dùng mâu thuẫn hình học với miền cơ sở, router tự động đưa vào mỗi ràng buộc một biến bù không âm $s_k \ge 0$ với hình phạt đồng đều `UNIFORM_CONFLICT_SLACK_PENALTY`:
   $$\theta \cdot \mathbf{\Delta}_k + s_k \ge \text{CHOICE\_MARGIN}$$
   Miền chấp nhận được định nghĩa là tập hợp các điểm có tổng biến bù không vượt quá mức bù tối thiểu cộng dung sai số học. Đây là giới hạn toán học của biểu diễn tuyến tính, không phải lỗi của người dùng.

### 3.5. Trọng số đại diện và Dự phòng trung tâm (Central Fallback)

Từ miền $\Theta$, router tính toán một điểm đại diện tất định $\theta_{\text{rep}}$ bằng cách tìm điểm gần nhất với trọng số mặc định $\theta_0$ theo chuẩn khoảng cách $L_1$, phân xử hòa điểm bằng thứ tự từ điển qua từng chiều trọng số.

Nếu bộ giải HiGHS gặp lỗi ngoại lệ hoặc quá thời hạn tính toán, router lập tức kích hoạt **Central Fallback**:
$$\text{utility}(a) = \sum_{j=0}^{9} \theta_{0, j} \times center_j(a)$$
Ứng viên có độ hữu dụng trung tâm cao nhất được chọn ngay lập tức, đảm bảo không bao giờ làm nghẽn tiến trình của người dùng.

---

## 4. Hợp đồng thực thi (Execution Contract)

Mô-đun `execution-contract.ts` và `execution-difficulty.ts` điều phối việc bàn giao có kiểm soát từ các giai đoạn phân tích/thiết kế (`plan`, `review`) sang giai đoạn sửa đổi mã nguồn (`implement`).

### 4.1. Cấu trúc và Xác thực hợp đồng (`commit_execution`)

Khi model đề xuất một kế hoạch thực thi, nó gọi công cụ `commit_execution` kèm danh sách các bước cụ thể:
- `edit`, `create`: Phải có đường dẫn file rõ ràng và mô tả nội dung thay đổi.
- `delete`: Phải có đường dẫn file rõ ràng.
- `verify`: Chỉ định lệnh kiểm tra tự động (`test`, `typecheck`, `lint`, `build`).

Hàm `validateContract` kiểm tra các ràng buộc:
1. Số bước không được vượt quá `MAX_CONTRACT_STEPS = 12`.
2. Đường dẫn không được chứa ký tự đại diện glob (`*`, `?`, `[`, `{`).
3. Phải tác động ít nhất một file cụ thể.

### 4.2. Điều kiện bàn giao (`delegatableShape`) và Lý do giữ lại (`keepReason`)

Kế hoạch chỉ được bàn giao cho một model thực thi khác khi có hình dạng nhỏ gọn:
$$\text{delegatableShape} \iff \text{targets} \le 5 \quad \text{và} \quad \text{steps} \le 8$$

Nếu kế hoạch không thỏa mãn hoặc tiềm ẩn rủi ro, router chấp thuận kế hoạch nhưng **buộc chính model nộp kế hoạch (submitter) phải tự thực hiện**, được đánh dấu qua 4 lý do giữ lại (`keepReason`):
- **`size`**: Kế hoạch vượt quá 5 file hoặc quá 8 bước.
- **`unknown-target`**: Tồn tại file đích không có trên đĩa hoặc không thể đo đạc kích thước.
- **`delete`**: Kế hoạch có chứa bước xóa file (thao tác có tính phá hủy cao).
- **`open-decisions`**: Rubric thực thi khai báo `openDecisions >= 4` (vẫn còn quyết định thiết kế hoặc hành vi chưa được chốt dứt điểm).

### 4.3. Giám sát vòng đời thực thi

Khi một kế hoạch được giải phóng (`release: true`), bộ chọn Minimax Regret sẽ chọn một executor phù hợp. Vòng đời hợp đồng diễn ra qua các trạng thái:

```text
[active] ──(sửa đủ mọi target edit/create)──> [executed: complete] ──> [review]
   │
   ├──(dùng hết ngân sách gọi model)────────> [executed: budget]   ──> [review]
   │
   └──(vi phạm cam kết hoặc ma sát)────────> [broken]             ──> [trả về submitter]
```

1. **Ngân sách thực thi**: Executor được cấp tối đa $\text{budget} = 2 \times \text{steps} + 4$ lượt gọi provider. Nếu hết ngân sách mà chưa xong, hợp đồng chuyển sang `executed` với lý do `budget`.
2. **Ghi nhận hoàn thành**: Mỗi lệnh `edit`/`write` tích hợp thành công trên một file đích sẽ loại file đó khỏi danh sách `pending`. Khi `pending` rỗng, kế hoạch đạt trạng thái `executed: complete`.
3. **Phá vỡ hợp đồng (`broken`)**: Kế hoạch lập tức bị hủy và trả quyền điều khiển về cho submitter nếu executor:
   - Thực hiện lệnh `edit`/`write` trên một file nằm ngoài danh sách khai báo ban đầu.
   - Tự ý gọi lại `commit_execution`.
   - Vướng phải ma sát quỹ đạo (lặp thao tác, kiểm tra thất bại liên tiếp).

### 4.4. Cơ chế Rà soát bắt buộc (Review) và Xử lý Làm lại (Rework)

- **Bắt buộc rà soát**: Khi một model khác submitter hoàn thành kế hoạch, lượt gọi tiếp theo bắt buộc chuyển về cho submitter với vai trò `review`. Vì một kế hoạch đã sửa xong các file vẫn có thể sai sót logic tinh vi mà các bài kiểm tra tự động không bắt được; chỉ có submitter ban đầu mới hiểu rõ toàn bộ ý định thiết kế.
- **Xử lý làm lại (Rework)**: Nếu trong quá trình review, submitter nhận thấy kết quả không đạt và nộp lại một kế hoạch `commit_execution` mới, hành động này được định danh là `rework`.
- **Cơ chế loại trừ (`CONTRACT_STRIKE_LIMIT = 2`)**:
  - Mỗi lần làm vỡ hợp đồng (`broken`) hoặc khiến công việc phải làm lại (`rework`) tính 1 strike cho model thực thi đó.
  - Khi một model tích lũy đủ **2 strike** trong cùng một công việc, model đó lập tức bị đưa vào danh sách loại trừ (`excludedExecutors`), bị cấm thực thi mọi kế hoạch tiếp theo của công việc này trên tất cả các mức effort và provider.

---

## 5. Vòng lặp ủy quyền và phục hồi lỗi (Delegation & Fallback Loop)

Mô-đun `delegation.ts` là cơ cấu chấp hành điều phối luồng stream trực tiếp từ Pi đến các model theo thứ tự của chuỗi fallback chain đã được bộ chọn xếp hạng.

### 5.1. Bộ đệm trước nội dung (Pre-Output Buffering)

Để ngăn chặn việc rò rỉ các phản hồi hỏng hoặc trống từ các model thất bại ra giao diện người dùng, lớp `AttemptController` duy trì một bộ đệm sự kiện trước khi model tạo ra nội dung có nghĩa:

- **Giới hạn bộ đệm**: Tối đa `MAX_BUFFERED_EVENTS = 10.000` sự kiện hoặc `MAX_PREOUTPUT_BUFFER_CHARS = 1.000.000` ký tự.
- **Xả đệm trực tiếp (Passthrough)**: Ngay khi nhận được một sự kiện nội dung có nghĩa đầu tiên (`text_delta` có nội dung hiển thị hoặc `toolcall_start`), toàn bộ sự kiện đang bị giữ trong đệm lập tức được xả (flush) vào stream của Pi, và các sự kiện sau đó được truyền thẳng theo thời gian thực.
- **Tràn đệm suy luận**: Nếu bộ đệm bị tràn nhưng bên trong **đã có chứa nội dung suy luận** (`thinking_delta`), controller tự động cam kết phát trực tiếp ra stream (`committedToStream = true`). Ngược lại, nếu tràn do sự kiện rác vòng đời mà không có suy luận, candidate bị coi là lỗi và chuyển fallback.

### 5.2. Phân loại lỗi và Chính sách thử lại (Retries Policy)

| Loại lỗi | Số lần thử lại tối đa | Hành động tiếp theo |
|---|---|---|
| Lỗi mạng tạm thời, quá tải máy chủ (5xx, overload) | 2 lần (`MAX_TRANSIENT_RETRIES`) kèm exponential backoff | Chuyển sang candidate tiếp theo trong chain |
| Lỗi provider chung (`stopReason: 'error'`) | 1 lần (`MAX_GENERIC_RETRIES`) | Chuyển sang candidate tiếp theo trong chain |
| Quá hạn phản hồi sự kiện đầu tiên (30s) | 0 lần | Chuyển sang candidate tiếp theo |
| Hết hạn mức suy luận trước khi có câu trả lời (`stopReason: 'length'`) | 0 lần | Chuyển sang candidate tiếp theo (không tính provider strike) |
| Model từ chối tiếp tục tool loop từ model khác | 1 lần gửi kèm prompt dẫn dắt (`TOOL_LOOP_HANDOFF_PROMPT`) | Nếu vẫn từ chối thì chuyển tiếp (không blacklist) |

### 5.3. Tính bất khả đảo ngược (The Irreversibility Rule)

Một khi candidate đang phục vụ đã thỏa mãn ít nhất một trong các điều kiện:
1. Đã phát ra ít nhất một ký tự văn bản hiển thị ra giao diện (`visibleTextReceived === true`),
2. Đã phát ra ít nhất một lời gọi công cụ (`toolCallReceived === true`),
3. Đã cam kết giải phóng buffer suy luận do tràn dung lượng (`committedToStream === true`),

thì **tuyệt đối không bao giờ được phép hủy ngang để replay trên một model khác trong chuỗi fallback**. Bất kỳ lỗi nào phát sinh sau thời điểm này đều được báo thẳng vào luồng dữ liệu của người dùng. Quy tắc này triệt tiêu hoàn toàn nguy cơ sinh văn bản trùng lặp và ngăn chặn các tác dụng phụ nguy hiểm (side-effects) do việc thực thi lại các lệnh shell hoặc chỉnh sửa file đã diễn ra một phần.

### 5.4. Ngắt mạch nhà cung cấp (Provider Circuit Breaker)

- **Tích lũy 3 strike sức khỏe (`MAX_FAILURES_PER_PROVIDER = 3`)**: Nếu một provider tích lũy đủ 3 lỗi nghiêm trọng (lỗi xác thực, mạng hỏng, lỗi 5xx lặp lại), toàn bộ các model khác thuộc provider đó trong chuỗi fallback đều bị bỏ qua ngay lập tức.
- **Ngắt mạch tức thì do cạn hạn mức (Usage Limit 429 / Billing Cap)**: Khi bắt gặp lỗi cạn tiền, hết quota gói cước, hoặc mã lỗi 429 có tính chất tài khoản (`isUsageLimitErrorMessage`), router lập tức cô lập toàn bộ provider trên toàn phiên làm việc mà không cần chờ tích lũy đủ 3 strike. Lỗi này có thể gỡ bỏ thủ công khi đã nạp tiền qua lệnh `/router-blacklist remove <provider>/*`.

### 5.5. Phát hiện vòng lặp suy luận và Can thiệp trước nội dung

Lớp `ReasoningLoopDetector` phân tích các chuỗi `thinking_delta` theo thời gian thực để nhận diện các trạng thái lặp lại ý niệm hoặc bế tắc suy luận:
- Nếu phát hiện mức độ nghiêm trọng (`severe`) trong khi nội dung hiển thị **chưa hề được phát ra**, router kích hoạt quy trình can thiệp trước nội dung (`decidePreOutputIntervention`).
- Router kiểm tra xem có model nào mạnh hơn trong chuỗi fallback có khả năng giải quyết bế tắc hay không. Nếu có, lượt gọi hiện tại được hủy bỏ sạch sẽ, toàn bộ đệm bị hủy và quyền thực thi được chuyển ngay sang model cứu hộ mà người dùng không hề thấy dấu vết gián đoạn.

### 5.6. Xử lý phản hồi rỗng trên đuôi tổng hợp (Synthetic Tail Handling)

Khi các tin nhắn nằm sau tin nhắn trợ lý cuối cùng hoàn toàn là các tin nhắn tổng hợp nội bộ do hệ thống chèn vào (ví dụ bản tóm tắt ngữ cảnh compaction hoặc lời nhắc hợp đồng):
- Một phản hồi rỗng (`empty answer`) kết thúc bằng `done` với mã `stopReason: 'stop'` được công nhận là **phục vụ thành công hợp lệ**.
- Router hoàn tất lượt gọi trong êm thấm, không xem đây là lỗi model, không kích hoạt fallback và không ghi nhận bất kỳ provider strike nào.
