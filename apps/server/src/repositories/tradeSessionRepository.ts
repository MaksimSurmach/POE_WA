import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

const tokenPattern = /^[A-Za-z0-9_-]{1,256}$/;
const associatedData = Buffer.from('poe-worksmith:trade-session:v1');

export function createTradeSessionRepository(
  pool: Pick<Pool, 'query'>,
  hexKey: string | undefined,
) {
  if (!hexKey || !/^[a-fA-F0-9]{64}$/.test(hexKey))
    throw new Error('TRADE_SESSION_KEY_INVALID');
  const key = Buffer.from(hexKey, 'hex');

  return {
    async save(session: string) {
      if (!tokenPattern.test(session)) throw new Error('TRADE_SESSION_INVALID');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(associatedData);
      const ciphertext = Buffer.concat([
        cipher.update(session),
        cipher.final(),
      ]);
      const sealed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
      await pool.query(
        `insert into market_collector_private.trade_session(singleton, sealed_session)
         values(true,$1) on conflict (singleton) do update set
           sealed_session=excluded.sealed_session, updated_at=now()`,
        [sealed.toString('base64')],
      );
    },
    async read() {
      const result = await pool.query<{ sealed_session: string }>(
        'select sealed_session from market_collector_private.trade_session where singleton',
      );
      if (!result.rows[0]) return null;
      try {
        const sealed = Buffer.from(result.rows[0].sealed_session, 'base64');
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          sealed.subarray(0, 12),
        );
        decipher.setAAD(associatedData);
        decipher.setAuthTag(sealed.subarray(12, 28));
        const session = Buffer.concat([
          decipher.update(sealed.subarray(28)),
          decipher.final(),
        ]).toString('utf8');
        if (!tokenPattern.test(session)) throw new Error();
        return session;
      } catch {
        throw new Error('TRADE_SESSION_DECRYPT_FAILED');
      }
    },
  };
}
