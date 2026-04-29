export const bumpVersion = (
  currentVersion: string | null | undefined,
): string => {
  const num = parseInt((currentVersion ?? 'v0').replace('v', ''), 10);
  return `v${isNaN(num) ? 1 : num + 1}`;
};

export const getExpiryDate = (hours: number = 24): Date => {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d;
};
