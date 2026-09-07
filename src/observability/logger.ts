export const log = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  context: Record<string, unknown> = {},
): void => {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...context }));
};
