import { jwtVerify as joseJwtVerify } from "jose";
export async function jwtVerify(
  token: string,
  secret: Uint8Array<ArrayBuffer>,
): Promise<{ payload: any }> {
  const { payload } = await joseJwtVerify(token, secret);
  return { payload };
}
