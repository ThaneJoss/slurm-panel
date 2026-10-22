/** Compact old parameter-heavy names while retaining the recorded name in the API. */
export function displayName(name, preferred) {
  if (typeof preferred === 'string' && preferred.trim()) return preferred.trim();
  const original = String(name ?? '');
  const known = [
    ['fv-group-relative-direction', 'FV 相对方向'],
    ['fv-group-consistency', 'FV 一致性'],
  ].find(([prefix]) => original === prefix || original.startsWith(`${prefix}-`));
  if (known) return known[1] + (/-resume\d*/.test(original) ? '续训' : '');
  if (!original.includes('-') || /\s/.test(original)) return original;
  const parts = original.split('-').filter((part) => (
    !/^(?:s\d+|seed\d+|e\d+|\d+epochs?|\d+h|resume\d+|eq\d+|dir\d+|20\d{6})$/i.test(part)
  ));
  return parts.length ? parts.join(' ') : original;
}
