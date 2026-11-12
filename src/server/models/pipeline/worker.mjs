// A worker thread for one validate or re-encode task (see run.ts, which sets the memory and time caps).
import { parentPort, workerData } from 'node:worker_threads';
import { ModelRefusal, reencodeModel, validateModel } from './engine.mjs';

const { task, bytes, limits } = workerData;
try {
  const input = new Uint8Array(bytes);
  if (task === 'validate') {
    parentPort.postMessage({ ok: true, result: await validateModel(input) });
  } else if (task === 'reencode') {
    const result = await reencodeModel(input, limits);
    parentPort.postMessage({ ok: true, result }, [result.bytes.buffer]);
  } else {
    parentPort.postMessage({ ok: false, error: { code: 'bad-task', message: 'unknown task', status: 500 } });
  }
} catch (err) {
  const refusal = err instanceof ModelRefusal;
  parentPort.postMessage({ ok: false, error: { code: refusal ? err.code : 'worker-failed', message: refusal ? err.message : 'the model could not be processed', status: refusal ? err.status : 500 } });
}
