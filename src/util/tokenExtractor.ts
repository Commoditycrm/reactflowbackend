export const getTokenFromHeader = (
  header: string | undefined
): string | null => {
  if (header && header.startsWith("Bearer")) {
    const token = header.split(" ")[1];
    return token ?? null; // Return the token part or null if undefined
  }

  return null;
};
