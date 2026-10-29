import fp from 'fastify-plugin';
// Compatibility for historical payment/refund code. No paid access gates.
export async function invalidateSubscriptionCache(_workspaceId: number): Promise<void> {}
export default fp(async app => { app.log.info('Community edition: free access'); }, { name: 'subscription-plugin' });
