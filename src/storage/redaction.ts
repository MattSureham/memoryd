const REDACTED = "[REDACTED]";

interface Pattern {
  label: string;
  expression: RegExp;
  replacement: string;
}

const PATTERNS: readonly Pattern[] = [
  {
    label: "private_key",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
    replacement: `${REDACTED}:private_key`,
  },
  {
    label: "openai_api_key",
    expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu,
    replacement: `${REDACTED}:openai_api_key`,
  },
  {
    label: "github_token",
    expression: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
    replacement: `${REDACTED}:github_token`,
  },
  {
    label: "slack_token",
    expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
    replacement: `${REDACTED}:slack_token`,
  },
  {
    label: "aws_access_key",
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
    replacement: `${REDACTED}:aws_access_key`,
  },
  {
    label: "authorization_bearer",
    expression: /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/giu,
    replacement: `$1${REDACTED}:bearer_token`,
  },
  {
    label: "credential_assignment",
    expression: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b(\s*[:=]\s*)["']?[^\s,"'\]}]{6,}["']?/giu,
    replacement: `$1$2${REDACTED}:credential`,
  },
  {
    label: "url_credentials",
    expression: /(https?:\/\/[^\s/:@]+:)[^\s/@]+@/giu,
    replacement: `$1${REDACTED}:password@`,
  },
];

const SENSITIVE_KEY = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)/iu;

export interface RedactionResult<T = string> {
  value: T;
  redactions: string[];
}

export function redactSensitiveContent(content: string): RedactionResult<string> {
  let value = content;
  const redactions = new Set<string>();
  for (const pattern of PATTERNS) {
    pattern.expression.lastIndex = 0;
    if (pattern.expression.test(value)) redactions.add(pattern.label);
    pattern.expression.lastIndex = 0;
    value = value.replace(pattern.expression, pattern.replacement);
  }
  return { value, redactions: [...redactions].sort() };
}

export function redactSensitiveValue<T>(input: T): RedactionResult<T> {
  const redactions = new Set<string>();

  const visit = (value: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) {
      redactions.add(`metadata:${key}`);
      return `${REDACTED}:sensitive_field`;
    }
    if (typeof value === "string") {
      const result = redactSensitiveContent(value);
      for (const item of result.redactions) redactions.add(item);
      return result.value;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          visit(childValue, childKey),
        ]),
      );
    }
    return value;
  };

  return {
    value: visit(input) as T,
    redactions: [...redactions].sort(),
  };
}
