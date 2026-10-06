# taskq

Small TypeScript utilities. No dependencies.

- Node 24 runs the `.ts` files directly. Use only erasable TypeScript syntax: no `enum`, no `namespace`, no constructor parameter properties.
- Import local files with the `.ts` extension, for example `import { sleep } from './sleep.ts'`.
- Run the tests with `npm test` (`node --test`). Tests live in `test/*.test.ts` and use `node:test` and `node:assert/strict`.
