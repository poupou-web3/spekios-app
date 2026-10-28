import { postgres } from './local-clients.mjs';
const result=JSON.parse(await postgres("SELECT json_build_object('runs',(SELECT count(*) FROM runtime_runs WHERE lifecycle='active'),'jobs',(SELECT count(*) FROM browser_jobs WHERE status IN ('queued','running')),'model_requests',(SELECT count(*) FROM model_requests WHERE state IN ('queued','preparing','dispatched')));"));
if(Object.values(result).some(Number))throw new Error('Finish or recover active runs, jobs and model requests before restarting services for fixture tests.');
