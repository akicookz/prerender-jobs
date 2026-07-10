// Job-wide tally of what the browser actually put on the wire, shared across
// all streams like the AssetCache. "Origin" means the customer's hosts
// (render target + routing domains) — the traffic this job tries to minimize.
export class RequestStats {
  private _originRequests = 0;
  private _thirdPartyRequests = 0;
  private _blockedRequests = 0;

  static register(): RequestStats {
    return new RequestStats();
  }

  countOutbound({ isCustomerHost }: { isCustomerHost: boolean }): void {
    if (isCustomerHost) {
      this._originRequests++;
    } else {
      this._thirdPartyRequests++;
    }
  }

  countBlocked(): void {
    this._blockedRequests++;
  }

  stats(): {
    originRequests: number;
    thirdPartyRequests: number;
    blockedRequests: number;
  } {
    return {
      originRequests: this._originRequests,
      thirdPartyRequests: this._thirdPartyRequests,
      blockedRequests: this._blockedRequests,
    };
  }
}
