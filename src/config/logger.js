const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const PALETTE = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  grey: '\x1b[90m',
};

const COLORS = {
  error: PALETTE.red,
  warn: PALETTE.yellow,
  info: PALETTE.green,
  debug: PALETTE.grey,
};
const RESET = '\x1b[0m';

const configuredLevel = () => {
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
};

// Colors are only emitted for a real terminal, so redirected logs stay clean.
// `color` overrides the level's default when a specific line should stand out.
const paint = (level, text, color) => {
  if (!process.stdout.isTTY) return text;
  return `${PALETTE[color] || COLORS[level]}${text}${RESET}`;
};

const write = (level, message, meta, options) => {
  if (LEVELS[level] > configuredLevel()) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  const painted = paint(level, line, options && options.color);
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;

  if (meta === undefined) {
    stream(painted);
  } else {
    stream(painted, meta);
  }
};

export const logger = {
  error: (message, meta, options) => write('error', message, meta, options),
  warn: (message, meta, options) => write('warn', message, meta, options),
  info: (message, meta, options) => write('info', message, meta, options),
  debug: (message, meta, options) => write('debug', message, meta, options),
};

export default logger;
