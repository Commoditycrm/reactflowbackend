import { createLogger, format, transports } from "winston";

const developmentLogger = () => {
  const { combine, colorize, timestamp, printf, metadata, errors } = format;

  const devFormat = printf(({ level, message, timestamp, stack, metadata }) => {
    const metaKeys = metadata && Object.keys(metadata).length > 0;
    const metaStr = metaKeys ? " " + JSON.stringify(metadata) : "";
    const msg = stack ? `${message}\n${stack}` : message;
    return `${timestamp} [${level}] ${msg}${metaStr}`;
  });

  return createLogger({
    level: "debug",
    format: combine(
      colorize(),
      errors({ stack: true }),
      metadata({ fillExcept: ["message", "level", "timestamp", "stack"] }),
      timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      devFormat
    ),
    transports: [new transports.Console()],
  });
};

export default developmentLogger;
