// LP worker for the unified selector. It owns one HiGHS WebAssembly instance
// and solves a batch of linear objectives over one polytope. The parent
// terminates this worker to enforce a hard deadline: a synchronous WASM solve
// cannot be interrupted from the main event loop.
//
// Message in:  { id, polytope: { numCols, colLower, colUpper, rows: [{ coeffs, lower, upper }] },
//                objectives: number[][], sense: 'max' | 'min' }
// Message out: { id, results: [{ status, objective, x }] } or { id, error }
import { parentPort } from 'node:worker_threads';
import loadHighs from 'highs';

const highsPromise = loadHighs();

const STATUS = { 7: 'optimal', 8: 'infeasible', 9: 'infeasible-or-unbounded', 10: 'unbounded' };

function toModelData(highs, polytope, sense) {
  const starts = [0];
  const indices = [];
  const values = [];
  const rowLower = [];
  const rowUpper = [];
  for (const row of polytope.rows) {
    row.coeffs.forEach((value, column) => {
      if (value !== 0) {
        indices.push(column);
        values.push(value);
      }
    });
    starts.push(indices.length);
    rowLower.push(row.lower ?? -highs.infinity);
    rowUpper.push(row.upper ?? highs.infinity);
  }
  return {
    numCols: polytope.numCols,
    numRows: polytope.rows.length,
    sense: sense === 'max' ? highs.constants.objectiveSense.maximize : highs.constants.objectiveSense.minimize,
    colCost: new Array(polytope.numCols).fill(0),
    colLower: polytope.colLower.map((value) => value ?? -highs.infinity),
    colUpper: polytope.colUpper.map((value) => value ?? highs.infinity),
    rowLower,
    rowUpper,
    matrix: { format: 'csr', numRows: polytope.rows.length, numCols: polytope.numCols, starts, indices, values },
  };
}

parentPort.on('message', async (message) => {
  const { id, polytope, objectives, sense } = message;
  try {
    const highs = await highsPromise;
    const model = highs.createModel(toModelData(highs, polytope, sense));
    try {
      model.options.set({ output_flag: false });
      const results = [];
      for (const objective of objectives) {
        model.changeColsCost({ kind: 'range', from: 0, to: polytope.numCols - 1 }, objective);
        model.run();
        const code = model.getModelStatus();
        const status = STATUS[code] ?? `status-${code}`;
        if (status === 'optimal') {
          results.push({ status, objective: model.getObjectiveValue(), x: Array.from(model.getSolution().colValue) });
        } else {
          results.push({ status });
        }
      }
      parentPort.postMessage({ id, results });
    } finally {
      model.dispose();
    }
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
