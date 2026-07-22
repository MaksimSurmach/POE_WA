export const calculatorContractVersion = 1;

export async function deriveCraftProbabilityCacheKey(input: {
  setupHash: string;
  gameDataVersion: string;
  rulesetId: string;
  engineId: string;
  engineVersion: string;
}) {
  const value = JSON.stringify({
    setupHash: input.setupHash,
    gameDataVersion: input.gameDataVersion,
    rulesetId: input.rulesetId,
    engineId: input.engineId,
    engineVersion: input.engineVersion,
    calculatorContractVersion,
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
