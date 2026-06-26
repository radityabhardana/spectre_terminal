import { evaluateSingleEvent } from './src/evaluate.js';

(async () => {
  console.log("Starting test...");
  try {
    const res = await evaluateSingleEvent(104);
    console.log("Result:", res);
  } catch (err) {
    console.error("Uncaught error:", err);
  }
})();
