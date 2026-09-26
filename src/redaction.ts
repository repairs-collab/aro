const SECRET_KEYS =
  /^(authentication|authorization|afdatetimeutc|hostip|uencoded|pencoded|orgencoded|secretkey|mcpaccesstoken|postxml)$/i;
const ADDITIONAL_SECRET_KEYS = /^(signature|accesstoken)$/i;
const REDACTED = '[REDACTED]';

const SENSITIVE_XML_TAGS =
  'authentication|authorization|afdatetimeutc|hostip|uencoded|pencoded|orgencoded|secretkey|mcpaccesstoken|postxml|signature|accesstoken';
const SENSITIVE_XML_VALUE = new RegExp(
  `(<(${SENSITIVE_XML_TAGS})\\b[^>]*>)[\\s\\S]*?(<\\/\\2\\s*>)`,
  'gi'
);

function isSecretKey(key: string): boolean {
  const normalizedKey = key.replace(/[-_\s]/g, '');
  return SECRET_KEYS.test(normalizedKey) || ADDITIONAL_SECRET_KEYS.test(normalizedKey);
}

function redactText(value: string, sensitiveValues: readonly string[]): string {
  let result = value.replace(SENSITIVE_XML_VALUE, `$1${REDACTED}$3`);

  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length === 0 || sensitiveValue === REDACTED) continue;
    result = result.split(sensitiveValue).join(REDACTED);
  }

  return result;
}

export function redact(value: unknown, sensitiveValues: readonly string[] = []): unknown {
  const seen = new WeakMap<object, unknown>();

  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') return redactText(current, sensitiveValues);
    if (current === null || typeof current !== 'object') return current;

    const existing = seen.get(current);
    if (existing !== undefined) return existing;

    if (Array.isArray(current)) {
      const output = new Array<unknown>(current.length);
      seen.set(current, output);
      for (let index = 0; index < current.length; index += 1) {
        if (Object.hasOwn(current, index)) output[index] = visit(current[index]);
      }
      return output;
    }

    const output = Object.create(null) as Record<string, unknown>;
    seen.set(current, output);

    if (current instanceof Error) {
      output.name = current.name;
      output.message = redactText(current.message, sensitiveValues);
      if (current.stack !== undefined) output.stack = redactText(current.stack, sensitiveValues);
    }

    for (const [key, entry] of Object.entries(current)) {
      const redactedKey = redactText(key, sensitiveValues);
      output[redactedKey] = isSecretKey(key) ? REDACTED : visit(entry);
    }

    return output;
  };

  return visit(value);
}
