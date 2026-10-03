/** Output projection only: callers decide success from the original receipt. */
export function summarizeReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  const summary = { ...receipt };
  const counts: Record<string, number> = {};
  for (const field of ['created', 'updated', 'reused', 'skipped', 'steps', 'checks', 'objects']) {
    const values = receipt[field];
    if (!Array.isArray(values)) continue;
    counts[field] = values.length;
    if (field === 'checks') summary[field] = values.filter((v) => v.status !== 'passed');
    else if (field === 'objects')
      summary[field] = values.map((v) => ({
        remId: v.remId,
        textHash: v.textHash,
        cardIds: v.cards.map((c: { cardId: string }) => c.cardId),
      }));
  }
  return { ...summary, counts };
}
