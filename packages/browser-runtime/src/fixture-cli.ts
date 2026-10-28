import { explorationFixture } from './exploration-fixture.js';
const fixture = await explorationFixture(8082, '0.0.0.0');
console.log('Controlled exploration fixture listening on port 8082.');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void fixture.close().then(() => process.exit(0)); });
