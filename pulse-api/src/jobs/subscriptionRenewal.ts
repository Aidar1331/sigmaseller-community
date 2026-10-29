/** Free edition: recurring billing and renewal notifications are disabled. */
export async function runSubscriptionRenewal() { return { preNotified: 0, charged: 0, failed: 0, skippedNoMethod: 0 }; }
