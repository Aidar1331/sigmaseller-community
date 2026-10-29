/** Billing consent is specific to WB; it never authorizes shared AI or mail keys. */
export function isWbBillingAuthorized(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.WB_PARTNER_BILLING_ACCEPTED === '1'
    || environment.WB_PARTNER_BILLING_VERIFIED_FREE === '1';
}
