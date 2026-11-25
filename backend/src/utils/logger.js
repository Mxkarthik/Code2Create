import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';

export const LOG_FORMATS = Object.freeze({
  MINIMAL: 'minimal',
  DEBUG: 'debug',
  JSON: 'json'
});

const ANSI = Object.freeze({
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  bold: '\x1b[1m'
});

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  'secret',
  'token',
  'csrfToken',
  'oauthCode',
  'codeVerifier',
  'accessToken',
  'refreshToken',
  'idToken',
  'clientSecret',
  'authToken',
  'authorization',
  'cookie',
  'connectionString',
  'uri',
  'MONGODB_URI',
  'MONGO_URI',
  'MONGODB_TEST_URI',
  'SESSION_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'JUDGE0_AUTH_TOKEN',
  'JWT_SECRET',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_API_KEY',
  '*.password',
  '*.secret',
  '*.token',
  '*.csrfToken',
  '*.oauthCode',
  '*.codeVerifier',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.clientSecret',
  '*.authToken',
  '*.authorization',
  '*.cookie',
  '*.connectionString',
  '*.uri',
  '*.MONGODB_URI',
  '*.MONGO_URI',
  '*.MONGODB_TEST_URI',
  '*.SESSION_SECRET',
  '*.GOOGLE_CLIENT_SECRET',
  '*.JUDGE0_AUTH_TOKEN',
  '*.JWT_SECRET',
  '*.CLOUDINARY_API_SECRET',
  '*.CLOUDINARY_API_KEY'
];

const DEBUG_OMIT_KEYS = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'service',
  'msg',
  'tag',
  'err'
]);

/**
 * Determine whether ANSI colors should be emitted based on NO_COLOR, FORCE_COLOR, and TTY.
 */
export function resolveColorSupport(stream, explicitUseColor) {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }

  if (typeof explicitUseColor === 'boolean') {
    return explicitUseColor;
  }

  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') {
    return true;
  }

  return Boolean(stream?.isTTY);
}

/**
 * Strip embedded credentials and query parameters from a MongoDB or HTTP URI before logging.
 */
export function sanitizeConnectionString(rawUri) {
  if (typeof rawUri !== 'string' || rawUri.length === 0) {
    return '[EMPTY_URI]';
  }

  try {
    const parsed = new URL(rawUri);
    const protocol = parsed.protocol;
    const host = parsed.host || '[unknown-host]';
    const pathname = parsed.pathname || '';
    const hasCredentials = Boolean(parsed.username || parsed.password);
    const authPrefix = hasCredentials ? '[REDACTED]@' : '';
    return `${protocol}//${authPrefix}${host}${pathname}`;
  } catch {
    return '[REDACTED_URI]';
  }
}

export function formatSeverityBadge(kind, useColor = false) {
  const label = `[${kind}]`;
  if (!useColor) {
    return label;
  }

  switch (kind) {
    case 'SUCCESS':
      return `${ANSI.green}${label}${ANSI.reset}`;
    case 'INFO':
      return `${ANSI.cyan}${label}${ANSI.reset}`;
    case 'WARN':
      return `${ANSI.yellow}${label}${ANSI.reset}`;
    case 'ERROR':
      return `${ANSI.red}${label}${ANSI.reset}`;
    default:
      return label;
  }
}

function resolveBadgeKind(entry) {
  if (entry.tag === 'SUCCESS') {
    return 'SUCCESS';
  }
  const lvl = String(entry.level || 'info').toLowerCase();
  if (lvl === 'warn') {
    return 'WARN';
  }
  if (lvl === 'error' || lvl === 'fatal') {
    return 'ERROR';
  }
  return 'INFO';
}

function formatDebugDetails(entry) {
  const parts = [];
  for (const [key, value] of Object.entries(entry)) {
    if (DEBUG_OMIT_KEYS.has(key) || value === undefined) {
      continue;
    }
    if (key === 'req' && value && typeof value === 'object') {
      parts.push(`req=${value.method} ${value.url}`);
      continue;
    }
    if (key === 'res' && value && typeof value === 'object') {
      parts.push(`status=${value.statusCode}`);
      continue;
    }
    parts.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }

  if (entry.err && typeof entry.err === 'object' && entry.err.message) {
    parts.push(`error=${entry.err.message}`);
  }

  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function formatHumanLine(rawJsonLine, { format, useColor }) {
  let entry;
  try {
    entry = JSON.parse(rawJsonLine);
  } catch {
    return `${rawJsonLine}\n`;
  }

  const kind = resolveBadgeKind(entry);
  const badge = formatSeverityBadge(kind, useColor);
  const message = entry.msg || '';

  if (format === LOG_FORMATS.DEBUG) {
    const details = formatDebugDetails(entry);
    return `${badge} ${message}${details}\n`;
  }

  // Minimal mode: concise single-line message; include concise error reason if not already in msg.
  if (kind === 'ERROR') {
    const reason = entry.errorMessage || entry.err?.message;
    if (reason && !message.includes(reason)) {
      return `${badge} ${message}: ${reason}\n`;
    }
  }

  return `${badge} ${message}\n`;
}

function createHumanFormatterStream({ targetStream, format, useColor }) {
  let remainder = '';

  return new Writable({
    write(chunk, _encoding, callback) {
      remainder += chunk.toString('utf8');
      let newlineIdx = remainder.indexOf('\n');

      while (newlineIdx !== -1) {
        const line = remainder.slice(0, newlineIdx).trim();
        remainder = remainder.slice(newlineIdx + 1);
        if (line.length > 0) {
          targetStream.write(formatHumanLine(line, { format, useColor }));
        }
        newlineIdx = remainder.indexOf('\n');
      }

      callback();
    },
    final(callback) {
      const trailing = remainder.trim();
      if (trailing.length > 0) {
        targetStream.write(formatHumanLine(trailing, { format, useColor }));
      }
      remainder = '';
      callback();
    }
  });
}

function formatEnvironmentLabel(nodeEnv) {
  if (!nodeEnv || typeof nodeEnv !== 'string') {
    return 'Development';
  }
  return nodeEnv.charAt(0).toUpperCase() + nodeEnv.slice(1).toLowerCase();
}

/**
 * Create a logger supporting 'minimal', 'debug', and 'json' output modes,
 * while always enforcing Pino secret redaction across every mode.
 */
export function createLogger({
  level = 'info',
  format = LOG_FORMATS.JSON,
  destination,
  base,
  useColor
} = {}) {
  const targetStream = destination ?? process.stdout;
  const effectiveFormat = Object.values(LOG_FORMATS).includes(format)
    ? format
    : LOG_FORMATS.JSON;
  const colorEnabled = resolveColorSupport(targetStream, useColor);

  const options = {
    level,
    base: base === undefined ? { service: 'code2create-backend' } : base,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]'
    },
    formatters: {
      level(label) {
        return { level: label };
      }
    }
  };

  const pinoStream =
    effectiveFormat === LOG_FORMATS.JSON
      ? targetStream
      : createHumanFormatterStream({
          targetStream,
          format: effectiveFormat,
          useColor: colorEnabled
        });

  const logger = pino(options, pinoStream);

  logger.format = effectiveFormat;
  logger.useColor = colorEnabled;

  logger.success = function logSuccess(metaOrMsg, maybeMsg) {
    if (typeof metaOrMsg === 'string') {
      logger.info({ tag: 'SUCCESS' }, metaOrMsg);
      return;
    }
    logger.info({ ...(metaOrMsg ?? {}), tag: 'SUCCESS' }, maybeMsg);
  };

  logger.printStartupSummary = function printStartupSummary({
    environment = 'development',
    port,
    checks = []
  }) {
    if (level === 'silent') {
      return;
    }

    if (effectiveFormat === LOG_FORMATS.JSON) {
      logger.info(
        {
          event: 'server_ready',
          environment,
          port,
          checks
        },
        'Code 2 Create backend server ready'
      );
      return;
    }

    const divider = '------------------------------------';
    const lines = [
      colorEnabled ? `${ANSI.bold}CODE 2 CREATE — BACKEND${ANSI.reset}` : 'CODE 2 CREATE — BACKEND',
      divider
    ];

    for (const check of checks) {
      const badge = formatSeverityBadge(check.level ?? 'SUCCESS', colorEnabled);
      lines.push(`${badge} ${check.message}`);
    }

    lines.push(
      divider,
      `Environment : ${formatEnvironmentLabel(environment)}`,
      `Server      : http://localhost:${port}`,
      `Status      : Ready`,
      ''
    );

    targetStream.write(`${lines.join('\n')}\n`);
  };

  return logger;
}

function isClientCancellation(req, err) {
  return Boolean(
    req?.aborted ||
      err?.code === 'ECONNRESET' ||
      err?.code === 'ECONNABORTED' ||
      err?.type === 'request.aborted'
  );
}

/**
 * Create HTTP request logger that omits bodies, query strings, and sensitive headers,
 * suppresses routine development noise, and prevents duplicate error logging.
 */
export function createHttpLogger({ logger, format } = {}) {
  const effectiveLogger = logger ?? createLogger();
  const effectiveFormat = format ?? effectiveLogger.format ?? LOG_FORMATS.JSON;

  return pinoHttp({
    logger: effectiveLogger,
    genReqId(req) {
      return req.id;
    },
    customLogLevel(req, res, err) {
      // Never duplicate errors already logged by errorHandler.
      if (res.locals?.errorLoggedByHandler) {
        return 'silent';
      }

      if (isClientCancellation(req, err)) {
        return 'silent';
      }

      if (effectiveFormat === LOG_FORMATS.MINIMAL) {
        return err || res.statusCode >= 500 ? 'error' : 'silent';
      }

      if (effectiveFormat === LOG_FORMATS.DEBUG) {
        if (err || res.statusCode >= 500) {
          return 'error';
        }
        if (res.statusCode >= 400) {
          return 'warn';
        }
        return 'debug';
      }

      // JSON / production mode: suppress noisy probe traffic below 500
      const pathOnly = (req.url || '').split('?')[0];
      if ((pathOnly === '/api/health' || pathOnly === '/api/ready') && res.statusCode < 500) {
        return 'silent';
      }

      if (err || res.statusCode >= 500) {
        return 'error';
      }
      if (res.statusCode >= 400) {
        return 'warn';
      }
      return 'info';
    },
    customSuccessMessage(req, res, responseTime) {
      if (effectiveFormat === LOG_FORMATS.DEBUG) {
        const pathOnly = (req.url || '').split('?')[0];
        return `${req.method} ${pathOnly} -> ${res.statusCode} (${responseTime}ms)`;
      }
      return 'request completed';
    },
    customErrorMessage(req, res, err) {
      if (effectiveFormat !== LOG_FORMATS.JSON) {
        const pathOnly = (req.url || '').split('?')[0];
        return `${req.method} ${pathOnly} failed (${res.statusCode}): ${err?.message || 'Internal error'}`;
      }
      return 'request errored';
    },
    serializers: {
      req(req) {
        const rawUrl = typeof req.url === 'string' ? req.url : '';
        const pathOnly = rawUrl.split('?')[0];
        return {
          id: req.id,
          method: req.method,
          url: pathOnly,
          remoteAddress: req.remoteAddress,
          headers: {
            host: req.headers?.host,
            origin: req.headers?.origin,
            'user-agent': req.headers?.['user-agent'],
            'x-request-id': req.headers?.['x-request-id']
          }
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode
        };
      }
    }
  });
}
