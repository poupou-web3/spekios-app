// A changing page gets a bounded number of fresh plans before yielding to
// another branch. Counts are local to the URL, and completed, settled actions
// reset the streak. Totals remain in the run's evidence/configuration.
export const MAX_CONSECUTIVE_REPLANS_PER_PAGE = 3;

export class ExplorationRecovery {
  private readonly replans = new Map<string, number>();

  replan(url: string) {
    const consecutive = (this.replans.get(url) ?? 0) + 1;
    this.replans.set(url, consecutive);
    return { consecutive, defer: consecutive >= MAX_CONSECUTIVE_REPLANS_PER_PAGE };
  }

  progressed() { this.replans.clear(); }
}
