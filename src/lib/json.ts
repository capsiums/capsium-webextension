/** Shared JSON parsing for package config files with a uniform error. */
export function parseJsonConfig(file: string, bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${file} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
