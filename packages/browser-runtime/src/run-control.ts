import type { Store } from './store.js';

export class RunCancelled extends Error {
  constructor() { super('Cancelled by the user. In-flight action outcomes may be incomplete; provider usage may still settle.'); }
}

/** Durable dispatch fences plus a separate polling connection to interrupt
 * browser operations/model polling without interleaving recorder transactions. */
export class RunControl {
  private controller=new AbortController();
  readonly signal=this.controller.signal;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private pending:Promise<void>|undefined;
  private closed=false;
  constructor(private store:Store,readonly runId:string){}
  private observe(row:{cancel_id:string|null}|undefined) {
    if(!row)throw new Error('Run control is unavailable. No further action is permitted.');
    if(row.cancel_id)this.controller.abort(new RunCancelled());
    this.signal.throwIfAborted();
  }
  async check(lock=false) {
    this.signal.throwIfAborted();
    const result=await this.store.query('SELECT cancel_id FROM runtime_runs WHERE run_id=$1'+(lock?' FOR UPDATE':''),[this.runId]);
    this.observe(result.rows[0]);
  }
  start() {
    const poll=()=>{
      if(this.closed||this.signal.aborted)return;
      this.pending=(async()=>{
        try {
          const result=await this.store.pool.query('SELECT cancel_id FROM runtime_runs WHERE run_id=$1',[this.runId]);
          this.observe(result.rows[0]);
        } catch(error) { this.controller.abort(error); }
        if(!this.closed&&!this.signal.aborted)this.timer=setTimeout(poll,200);
      })();
    };
    poll();
  }
  async close(){this.closed=true;clearTimeout(this.timer);await this.pending;}
}
