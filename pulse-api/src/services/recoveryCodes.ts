import { randomBytes, createHash } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, userSessions } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';

export function recoveryCodeHash(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex');
}

export async function issueRecoveryCode(userId: number, connection: Pick<typeof db, 'execute'> = db): Promise<string> {
  const code = randomBytes(32).toString('hex').match(/.{8}/g)!.join('-');
  await connection.execute(sql`INSERT INTO account_recovery_codes (user_id, code_hash)
    VALUES (${userId}, ${recoveryCodeHash(code)}) ON CONFLICT (user_id)
    DO UPDATE SET code_hash = EXCLUDED.code_hash, created_at = now()`);
  return code;
}

export async function resetWithRecoveryCode(email: string, code: string, password: string): Promise<string | null> {
  const passwordHash = await hashPassword(password);
  return db.transaction(async tx => {
    // DELETE and password/session changes are one transaction. Concurrent reuse loses.
    const result = await tx.execute(sql`DELETE FROM account_recovery_codes r USING users u
      WHERE r.user_id = u.user_id AND u.email = ${email} AND r.code_hash = ${recoveryCodeHash(code)}
      RETURNING r.user_id`);
    const rows = (result as any).rows ?? result;
    const userId = Number(rows[0]?.user_id);
    if (!userId) return null;
    await tx.update(users).set({ passwordHash, resetToken: null, resetExpiresAt: null, failedLoginAttempts: 0, lockedUntil: null }).where(eq(users.userId, userId));
    await tx.execute(sql`UPDATE seller_oauth_grants SET revoked_at=now() WHERE user_id=${userId} AND revoked_at IS NULL`);
    await tx.delete(userSessions).where(eq(userSessions.userId, userId));
    return issueRecoveryCode(userId, tx);
  });
}
