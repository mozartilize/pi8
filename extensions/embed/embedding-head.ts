/**
 * Embedding heads — pure functions over E5-small query embeddings. No I/O,
 * no registry, no session state.
 *
 * Two readings of one vector, both for prompts the English keyword rules
 * cannot read:
 *  - thin: does the prompt only point back at the conversation ("ok làm tiếp
 *    đi", "続けて")? Nearest labelled examples, thin versus substantive.
 *  - kind: what kind of task does it ask for? Cosine to one task
 *    description per kind.
 *
 * E5 cosines sit close together (about 0.8–0.9), so each reading is decided
 * by a margin between cosines, never by a raw similarity. Short CJK requests
 * and greetings sit close to thin prompts, so the substantive examples carry
 * many of them. Measured with the real model: on held-out prompts (see
 * embedding-calibration.json) thin 0.03 read 33 of 34 thin prompts as thin
 * and none of 49 substantive ones, and no prompt of 126 other substantive
 * ones; kind 0.01 decided 26 of 49, 23 right, one raised above its label.
 * Changing an example, a description, or a margin is a reviewable event:
 * bump EMBEDDING_HEAD_VERSION and re-measure on prompts the change was not
 * tuned on.
 */
import type { TaskKind } from '../types.js';

/** Bump when examples, descriptions, margins, or the scoring rule change. */
export const EMBEDDING_HEAD_VERSION = 3;

/** Short prompts that name no work of their own, across languages. */
export const THIN_EXAMPLES: readonly string[] = [
  'ok go ahead', 'continue', 'yes do it', 'sounds good, proceed', "what's next?", 'implement it', 'fix it', 'go on',
  'ok làm tiếp đi', 'tiếp tục', 'làm đi', 'đồng ý, triển khai đi', 'tiếp theo là gì?', 'sửa nó đi', 'ok làm luôn',
  'sigue', 'adelante, hazlo', '¿qué sigue?', 'implementa eso',
  "continue s'il te plaît", 'vas-y', 'et ensuite ?', 'fais-le',
  'mach weiter', 'ok, mach das', 'was kommt als Nächstes?', 'setz das um',
  'continua', 'pode fazer', 'e agora?',
  '続けて', '進めてください', '次は？', 'それを実装して',
  '继续', '好的，做吧', '下一步是什么？', '实现它',
  '계속해', '좋아, 해줘', '다음은?',
  'продолжай', 'давай, делай', 'что дальше?',
  'lanjut', 'oke, kerjakan',
  'venga, adelante', 'procedi pure', '진행해', 'bora, pode seguir', 'lanjutkan', 'devam', 'はい、進めて', '好，继续做',
  'vâng, cứ làm tiếp', 'oui, continue', 'ja, weiter', 'да, продолжай',
];

/**
 * Short prompts that carry work of their own, including the near misses a
 * thin reading must reject: a named continuation ("continue with the OAuth
 * migration") and thanks or greetings.
 */
export const SUBSTANTIVE_EXAMPLES: readonly string[] = [
  'fix the login bug', 'add a CSV export command', 'why does this test fail?', 'explain what this function does',
  'rename user to account in the auth module', 'review the payment service', 'continue with the OAuth migration',
  'thanks', 'hi there',
  'sửa lỗi đăng nhập', 'thêm lệnh xuất CSV', 'tại sao test này bị lỗi?', 'giải thích hàm này', 'làm tiếp phần export PDF', 'cảm ơn',
  'arregla el error de inicio de sesión', 'añade paginación a la API', '¿por qué falla este test?',
  'corrige le bug de connexion', 'ajoute un export CSV', 'pourquoi ce test échoue ?',
  'behebe den Login-Fehler', 'füge einen CSV-Export hinzu', 'warum schlägt der Test fehl?',
  'corrige o bug de login', 'adicione exportação CSV',
  'ログインのバグを直して', 'CSVエクスポートを追加して', 'このテストはなぜ失敗する？',
  '修复登录错误', '添加CSV导出功能', '为什么这个测试失败？',
  '로그인 버그를 고쳐줘', 'CSV 내보내기를 추가해줘',
  'исправь ошибку входа', 'добавь экспорт в CSV',
  'perbaiki bug login', 'tambahkan ekspor CSV',
  'design the database schema for orders', 'propose a plan to split the monolith', 'good morning',
  'hello everyone', 'thiết kế schema cho bảng đơn hàng', 'đề xuất kế hoạch tách monolith', 'chào buổi tối',
  'diseña el esquema de la base de datos', 'buenas noches', 'propose un plan pour découper le monolithe',
  'bonsoir', 'entwirf das Datenbankschema', 'hallo zusammen', 'データベースのスキーマを設計して', 'マイクロサービス化の計画を立てて',
  '設定ファイルはどこ？', 'おはようございます', '设计订单表的数据库结构', '制定拆分单体的计划', '配置文件在哪里？', '早安', '주문 테이블 스키마를 설계해줘',
  '이 함수는 뭐 하는 거야?', '안녕하세요', 'спроектируй схему базы данных', 'привет всем', 'rancang skema basis data',
  'selamat pagi',
];

/**
 * One description per task kind, of the task the user wants done rather than
 * of a model. English: E5 compares across languages, and these measured
 * better on non-English prompts than per-language examples did.
 */
export const KIND_DESCRIPTIONS: Readonly<Record<TaskKind, string>> = {
  lightweight:
    'A very short simple message or greeting. Small talk only. No technical content.',
  gather:
    'A question that asks to find, locate, explain, or investigate something. Search the codebase. Explain how a concept works. Report on status.',
  plan:
    'A request to design, architect, strategize, or plan something. Evaluate tradeoffs between approaches. Draft an RFC or proposal. High-level thinking before building.',
  implement:
    'A request to write, modify, fix, or build code. Debug a bug. Refactor existing code. Add a feature. Run a command that mutates files.',
  review:
    'A request to review, critique, audit, or check existing work for quality, security, or correctness.',
};

const KINDS = Object.keys(KIND_DESCRIPTIONS) as TaskKind[];

/** Minimum lead of the thin neighbours over the substantive ones. */
export const THIN_MIN_MARGIN = 0.03;
/** Minimum lead of the best kind description over the next one. */
export const KIND_MIN_MARGIN = 0.01;
const NEIGHBOURS = 3;

/** Every text the heads compare against, in the order `referenceVectors` expects them. */
export function referenceTexts(): string[] {
  return [...THIN_EXAMPLES, ...SUBSTANTIVE_EXAMPLES, ...KINDS.map((kind) => KIND_DESCRIPTIONS[kind])];
}

export interface ReferenceVectors {
  thin: readonly Float32Array[];
  substantive: readonly Float32Array[];
  kinds: Readonly<Record<TaskKind, Float32Array>>;
}

/** Split embeddings of `referenceTexts()`, in that order, into the heads' references. */
export function referenceVectors(vectors: readonly Float32Array[]): ReferenceVectors {
  const thinEnd = THIN_EXAMPLES.length;
  const substantiveEnd = thinEnd + SUBSTANTIVE_EXAMPLES.length;
  const kinds = {} as Record<TaskKind, Float32Array>;
  KINDS.forEach((kind, index) => { kinds[kind] = vectors[substantiveEnd + index]!; });
  return { thin: vectors.slice(0, thinEnd), substantive: vectors.slice(thinEnd, substantiveEnd), kinds };
}

export interface EmbeddingReading {
  /** Lead of the nearest thin examples over the nearest substantive ones. */
  thinMargin: number;
  /** The margin clears THIN_MIN_MARGIN. */
  thin: boolean;
  kind: TaskKind;
  /** Lead of `kind` over the next kind. */
  kindMargin: number;
  /** The margin clears KIND_MIN_MARGIN. */
  kindDecided: boolean;
}

/** Read one L2-normalized query embedding against the references. */
export function readEmbedding(vector: Float32Array, refs: ReferenceVectors): EmbeddingReading {
  const thinMargin = nearest(vector, refs.thin) - nearest(vector, refs.substantive);
  const ranked = KINDS
    .map((kind) => ({ kind, score: dot(vector, refs.kinds[kind]) }))
    .sort((a, b) => b.score - a.score);
  const kindMargin = ranked[0]!.score - ranked[1]!.score;
  return {
    thinMargin,
    thin: thinMargin >= THIN_MIN_MARGIN,
    kind: ranked[0]!.kind,
    kindMargin,
    kindDecided: kindMargin >= KIND_MIN_MARGIN,
  };
}

/** Mean cosine to the NEIGHBOURS closest references. */
function nearest(vector: Float32Array, refs: readonly Float32Array[]): number {
  if (refs.length === 0) return 0;
  const closest = refs.map((ref) => dot(vector, ref)).sort((a, b) => b - a).slice(0, NEIGHBOURS);
  return closest.reduce((sum, score) => sum + score, 0) / closest.length;
}

function dot(a: Float32Array, b: Float32Array): number {
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i]! * b[i]!;
  return result;
}
