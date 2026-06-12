export const getTokenFromHeader = (
  header: string | undefined
): string | null => {
  if (!header) return null;

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;

  return parts[1] ?? null;
};
