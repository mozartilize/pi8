import { JobQueue as Correct } from './correct-queue.mjs';
import { JobQueue as Faulty } from './faulty-queue.mjs';
import { cancelFreesSlotCheck, weakCancelCheck } from './checks.mjs';

const attempt = (check, queue) => check(queue).then(() => 'pass', () => 'fail');
console.log({
  weakOnFaulty: await attempt(weakCancelCheck, Faulty),
  authoritativeOnFaulty: await attempt(cancelFreesSlotCheck, Faulty),
  weakOnCorrect: await attempt(weakCancelCheck, Correct),
  authoritativeOnCorrect: await attempt(cancelFreesSlotCheck, Correct),
});
