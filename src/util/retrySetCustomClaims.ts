async function retrySetClaims(fn: Function, attempts = 3, delayMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
  }
  throw lastErr;
}
export default retrySetClaims;
