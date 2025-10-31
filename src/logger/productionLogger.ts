import { createLogger, format, transports } from "winston";

const productionLogger = () => {
  const { combine, timestamp, errors, metadata, printf } = format;

  const cleanFormat = printf(
    ({ level, message, timestamp, metadata, stack }) => {
      const metaKeys = metadata && Object.keys(metadata).length > 0;
      const metaStr = metaKeys ? " " + JSON.stringify(metadata) : "";
      const msg = stack ? `${message}\n${stack}` : message;
      return `[${level}]:${timestamp} ${msg}${metaStr}`;
    }
  );

  return createLogger({
    level: "info",
    format: combine(
      errors({ stack: true }),
      metadata({ fillExcept: ["message", "level", "timestamp", "stack"] }),
      timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      cleanFormat
    ),
    transports: [
      new transports.Console(),
      new transports.File({
        filename: "myErrors.log",
        level: "warn",
      }),
    ],
  });
};

export default productionLogger;
