const ts = () => new Date().toISOString().slice(11, 23)
export const log = {
  info: (...a: unknown[]) => console.log(ts(), '[info]', ...a),
  warn: (...a: unknown[]) => console.warn(ts(), '[warn]', ...a),
  error: (...a: unknown[]) => console.error(ts(), '[error]', ...a),
}
