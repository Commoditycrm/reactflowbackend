export const getTokenFromHeader = (
  header: string | undefined
): string | null => {
  if (header && header.startsWith("Bearer")) {
    const token = header.split(" ")[1];
    return token ?? null; 
  }

  return null;
};
